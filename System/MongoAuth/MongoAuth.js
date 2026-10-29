import fs from "fs";
import os from "os";
import { randomUUID } from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";
import { useMultiFileAuthState, BufferJSON } from "@whiskeysockets/baileys";
import { sessionSchema } from "./Schema/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Local files are Baileys' working copy; MongoDB is the durable session store.
const CONFIGURED_SESSION_BASE_DIR = process.env.SESSION_DIR
  ? path.resolve(process.env.SESSION_DIR)
  : null;
const DEFAULT_SESSION_BASE_DIR = path.join(__dirname, "..", "session");
const LEASE_TTL_MS = 90_000;
const LEASE_RENEW_INTERVAL_MS = 30_000;


const LEGACY_KEY_TYPE_MAP = {
  preKeys: "pre-key",
  sessions: "session",
  senderKeys: "sender-key",
  appStateSyncKeys: "app-state-sync-key",
  appStateVersions: "app-state-sync-version",
  senderKeyMemory: "sender-key-memory",
};

export default class MongoAuth {
  /**
   * @param {string} sessionId
   */
  constructor(sessionId) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(sessionId)) || [".", ".."].includes(sessionId)) {
      throw new Error("SESSION_ID must contain only letters, numbers, dots, underscores, or hyphens.");
    }
    this.sessionId = sessionId;
    this.sessionBaseDir = CONFIGURED_SESSION_BASE_DIR || DEFAULT_SESSION_BASE_DIR;
    this.dir = path.join(this.sessionBaseDir, sessionId);
    this.persistQueue = Promise.resolve();
    this.leaseOwner = randomUUID();
    this.leaseHeld = false;
    this.leaseLost = false;
    this.leaseTimer = null;
    this.onLeaseLost = null;
  }

  async _ensureWritableDirectory() {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.access(this.dir, fs.constants.W_OK);
    } catch (err) {
      if (CONFIGURED_SESSION_BASE_DIR || !["EROFS", "EACCES", "EPERM"].includes(err.code)) {
        throw err;
      }
      this.sessionBaseDir = path.join(os.tmpdir(), "atlas-md-sessions");
      this.dir = path.join(this.sessionBaseDir, this.sessionId);
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.access(this.dir, fs.constants.W_OK);
      console.warn("[ ATLAS ] App directory is read-only; using OS temporary storage for the MongoDB-backed session.");
    }
  }

  _serializePersistence(operation) {
    const result = this.persistQueue.then(operation, operation);
    this.persistQueue = result.catch(() => {});
    return result;
  }

  /**
   * Initialize auth state using local → MongoDB → QR priority.
   * Returns { state, saveCreds, clearState } for makeWASocket.
   */
  async init() {
    console.log(`[ ATLAS ] Starting session: "${this.sessionId}"`);
    await this._ensureWritableDirectory();
    await this._acquireLease();

    const localExists = await this._localExists();

    if (!localExists) {
      const mongoExists = await this._mongoExists();
      if (mongoExists) {
        console.log(
          `[ ATLAS ] [${this.sessionId}] Session not found locally — downloading from MongoDB...`,
        );

        try {
          await this._downloadToLocal();
        } catch (err) {
          console.error(
            `[ EXCEPTION ] [${this.sessionId}] Session download failed: ${err.message} — wiping partial files.`,
          );
          await fs.promises.rm(this.dir, { recursive: true, force: true });
          throw new Error("MongoDB session restore failed; keeping the stored session untouched.");
        }

        const downloadOk = await this._localExists();
        if (downloadOk) {
          console.log(
            `[ ATLAS ] [${this.sessionId}] Session restored from MongoDB ✓`,
          );
        } else {
          await fs.promises.rm(this.dir, { recursive: true, force: true });
          throw new Error("MongoDB contains an incomplete WhatsApp session; refusing to replace it with a new QR session.");
        }
      } else {
        // Neither local nor MongoDB — empty dir triggers QR scan
        console.log(
          `[ ATLAS ] [${this.sessionId}] No existing session found — QR scan required.`,
        );
      }
    } else {
      console.log(`[ ATLAS ] [${this.sessionId}] Local session found ✓`);
    }

    const { state, saveCreds: saveCredsLocal } = await useMultiFileAuthState(
      this.dir,
    );

    const saveCreds = async () => this._serializePersistence(async () => {
      await saveCredsLocal();
      await this._pushToMongoDB().catch((err) =>
        console.error(
          `[ EXCEPTION ] MongoDB session sync error: ${err.message}`,
        ),
      );
    });

    const clearState = async () => {
      await this.persistQueue;
      await this._clearSession();
    };

    return { state, saveCreds, clearState };
  }

  /**
   * Push all local session files to MongoDB.
   * Called by the periodic background sync (GC interval).
   */
  async pushToMongoDB() {
    return this._serializePersistence(() => this._pushToMongoDB());
  }

  async _acquireLease() {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    await sessionSchema.init();
    const now = new Date();
    try {
      const lease = await sessionSchema.findOneAndUpdate(
        {
          sessionId: this.sessionId,
          $or: [
            { leaseOwner: this.leaseOwner },
            { leaseUntil: { $lte: now } },
            { leaseUntil: { $exists: false } },
            { leaseUntil: null },
          ],
        },
        {
          $setOnInsert: { sessionId: this.sessionId },
          $set: {
            leaseOwner: this.leaseOwner,
            leaseUntil: new Date(now.getTime() + LEASE_TTL_MS),
          },
        },
        { upsert: true, new: true },
      );
      if (!lease || lease.leaseOwner !== this.leaseOwner) {
        throw new Error("WhatsApp session is already active in another process.");
      }
      this.leaseHeld = true;
      this.leaseLost = false;
      this.leaseTimer = setInterval(() => {
        void this._renewLease();
      }, LEASE_RENEW_INTERVAL_MS);
      this.leaseTimer.unref?.();
    } catch (err) {
      this.leaseHeld = false;
      if (err.code === 11000) {
        throw new Error("WhatsApp session is already active in another process.");
      }
      throw err;
    }
  }

  async _renewLease() {
    try {
      const result = await sessionSchema.updateOne(
        { sessionId: this.sessionId, leaseOwner: this.leaseOwner },
        { $set: { leaseUntil: new Date(Date.now() + LEASE_TTL_MS) } },
      );
      if (result.matchedCount === 0) {
        throw new Error("Session lease is no longer owned by this process.");
      }
    } catch (err) {
      if (this.leaseLost) return;
      this.leaseHeld = false;
      this.leaseLost = true;
      console.error(`[ EXCEPTION ] WhatsApp session ownership lost: ${err.message}`);
      this.onLeaseLost?.();
    }
  }

  async releaseLease() {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    try {
      await sessionSchema.updateOne(
        { sessionId: this.sessionId, leaseOwner: this.leaseOwner },
        { $unset: { leaseOwner: "", leaseUntil: "" } },
      );
    } finally {
      this.leaseHeld = false;
    }
  }

  async _pushToMongoDB() {
    if (!this.leaseHeld || this.leaseLost) {
      throw new Error("Session lease is no longer valid.");
    }
    const localExists = await this._localExists();
    if (!localExists) return;

    let entries;
    try {
      entries = await fs.promises.readdir(this.dir);
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }

    let files;
    // Baileys can remove/replace pre-key files while credentials are being
    // persisted. Retry the snapshot so Mongo never receives a partial session.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      files = {};
      let retrySnapshot = false;
      for (const entry of entries) {
        const filePath = path.join(this.dir, entry);
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.isFile()) {
            const content = await fs.promises.readFile(filePath);
            files[entry] = content.toString("base64");
          }
        } catch (err) {
          if (err.code === "ENOENT") {
            retrySnapshot = true;
            break;
          }
          throw new Error(`Could not read auth file ${entry}: ${err.message}`);
        }
      }
      if (!retrySnapshot) break;
      if (attempt === 2) {
        throw new Error("Auth files changed during MongoDB snapshot; retrying on the next sync.");
      }
      try {
        entries = await fs.promises.readdir(this.dir);
      } catch (err) {
        if (err.code === "ENOENT") return;
        throw err;
      }
    }

    if (Object.keys(files).length === 0) return;

    const result = await sessionSchema.updateOne(
      { sessionId: this.sessionId, leaseOwner: this.leaseOwner },
      { $set: { files, lastSync: new Date() } },
    );
    if (result.matchedCount === 0) {
      this.leaseHeld = false;
      this.leaseLost = true;
      this.onLeaseLost?.();
      throw new Error("Session lease was lost before auth data could be saved.");
    }
  }

  async _localExists() {
    const credsPath = path.join(this.dir, "creds.json");
    try {
      const stat = await fs.promises.stat(credsPath);
      return stat.isFile() && stat.size > 0;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  async _mongoExists() {
    const doc = await sessionSchema.findOne({ sessionId: this.sessionId });
    if (!doc) return false;
    if (
      doc.files &&
      Object.keys(doc.files).some(
        (k) => doc.files[k] && doc.files[k].length > 0,
      )
    )
      return true;
    return Boolean(doc.session && doc.session.length > 0);
  }

  async _downloadToLocal() {
    const doc = await sessionSchema.findOne({ sessionId: this.sessionId });
    if (!doc) return;

    if (doc.session && !doc.files) {
      await this._migrateLegacySession(doc.session);
      return;
    }

    if (!doc.files) return;
    await fs.promises.mkdir(this.dir, { recursive: true });
    for (const [filename, base64Content] of Object.entries(doc.files)) {
      if (path.basename(filename) !== filename || filename === "." || filename === "..") {
        throw new Error("MongoDB session contains an invalid auth filename.");
      }
      if (!base64Content || base64Content.length === 0) {
        console.log(
          `[ ATLAS ] [${this.sessionId}] Skipping empty entry in MongoDB session: ${filename}`,
        );
        continue;
      }
      const filePath = path.join(this.dir, filename);
      await fs.promises.writeFile(
        filePath,
        Buffer.from(base64Content, "base64"),
      );
    }
  }

  /**
   * Convert the old single-blob session format into individual files that
   * useMultiFileAuthState can read, then push the new format to MongoDB.
   * @param {string} legacySessionString  The old `session` field value
   */
  async _migrateLegacySession(legacySessionString) {
    let parsed;
    try {
      parsed = JSON.parse(legacySessionString, BufferJSON.reviver);
    } catch (err) {
      console.error(
        `[ EXCEPTION ] Failed to parse legacy session blob: ${err.message}`,
      );
      return;
    }

    await fs.promises.mkdir(this.dir, { recursive: true });

    // Write creds.json
    if (parsed.creds) {
      await fs.promises.writeFile(
        path.join(this.dir, "creds.json"),
        JSON.stringify(parsed.creds, BufferJSON.replacer),
      );
    }

    const keys = parsed.keys || {};
    for (const [storageKey, baileyType] of Object.entries(
      LEGACY_KEY_TYPE_MAP,
    )) {
      const keyData = keys[storageKey];
      if (!keyData || typeof keyData !== "object") continue;
      for (const [id, value] of Object.entries(keyData)) {
        await fs.promises.writeFile(
          path.join(this.dir, `${baileyType}-${id}.json`),
          JSON.stringify(value, BufferJSON.replacer),
        );
      }
    }

    console.log(`[ ATLAS ] Legacy session migrated to new file-based format.`);

    await this.pushToMongoDB();
  }

  async _clearSession() {
    await fs.promises.rm(this.dir, { recursive: true, force: true });
    await sessionSchema.updateOne(
      { sessionId: this.sessionId, leaseOwner: this.leaseOwner },
      { $set: { files: {}, lastSync: new Date() }, $unset: { session: "" } },
    );

    console.log(`[ ATLAS ] Session cleared from local storage and MongoDB.`);
  }
}
