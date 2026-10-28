
import axios from "axios";

const mergedCommands = [
  "play",
  "song",
  "yt",
  "ytmp3",
  "mp3",
  "ytmp4",
  "video",
  "mp4",
];

const API_TIMEOUT = 15000;

// Evita acumular varias solicitudes simultáneas por chat.
const activeChats = new Set();

const YT_REGEX =
  /^(https?:\/\/)?((www|m|music)\.)?(youtube(-nocookie)?\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]+(\S+)?$/i;

const extractUrl = (text) => {
  if (!text) return null;
  const match = text.trim().match(YT_REGEX);
  return match ? match[0] : null;
};

const apiGet = async (url) => {
  const { data } = await axios.get(url, {
    timeout: API_TIMEOUT,
    maxContentLength: 2 * 1024 * 1024,
    maxBodyLength: 2 * 1024 * 1024,
  });

  return data;
};

export default {
  name: "youtube",
  alias: [...mergedCommands],
  uniquecommands: ["play", "mp3", "mp4"],
  description: "Advanced YouTube system (API based)",

  start: async (Atlas, m, { inputCMD, text, doReact, prefix }) => {
    const botName = global.botName || "ATLAS";
    const chatId = m.from;
    let query = text?.trim();

    if (!query && m.quoted?.text) {
      query = m.quoted.text.trim();
    }

    if (!query) {
      return m.reply(
        `🎬 *YouTube Downloader*\n\n` +
          `📌 *Usage:*\n` +
          `• ${prefix}play <song name>\n` +
          `• ${prefix}mp3 <youtube link>\n` +
          `• ${prefix}video <video name>\n` +
          `• ${prefix}mp4 <youtube link>\n` +
          `• ${prefix}yts <query>\n\n` +
          `✨ Reply to a link also works`,
      );
    }

    if (activeChats.has(chatId)) {
      return m.reply(
        "⏳ Ya tienes una solicitud de YouTube en proceso. Espera a que termine.",
      );
    }

    activeChats.add(chatId);

    try {
      switch (inputCMD) {
        case "mp4":
        case "ytmp4":
        case "video": {
          if (doReact) await doReact("🎥");

          let videoUrl = extractUrl(query);

          if (!videoUrl) {
            const search = await apiGet(
              `https://api-faa.my.id/faa/youtube?q=${encodeURIComponent(query)}`,
            );

            if (
              !search?.status ||
              !Array.isArray(search.result) ||
              !search.result.length ||
              !search.result[0]?.link
            ) {
              return m.reply("❌ No video found");
            }

            const result = search.result[0];
            videoUrl = result.link;

            if (result.imageUrl) {
              await Atlas.sendMessage(
                chatId,
                {
                  image: { url: result.imageUrl },
                  caption: `🎬 *${result.title || "YouTube"}*\n⏱ ${result.duration || "N/A"}\n\n⬇️ Downloading...`,
                },
                { quoted: m },
              );
            }
          }

          const videoData = await apiGet(
            `https://api-faa.my.id/faa/ytmp4?url=${encodeURIComponent(videoUrl)}`,
          );

          const downloadUrl = videoData?.result?.download_url;

          if (!videoData?.status || !downloadUrl) {
            throw new Error("No se pudo obtener el enlace del video.");
          }

          await Atlas.sendMessage(
            chatId,
            {
              video: { url: downloadUrl },
              mimetype: "video/mp4",
              caption: `🎬 *Video Downloaded*\n\n> Powered by ${botName}`,
            },
            { quoted: m },
          );

          if (doReact) await doReact("✅");
          break;
        }

        case "mp3":
        case "ytmp3": {
          if (doReact) await doReact("🎶");

          const audioUrl = extractUrl(query);

          if (!audioUrl) {
            return m.reply(
              "❌ Invalid YouTube link. Please provide a valid YouTube URL for mp3.",
            );
          }

          const audioData = await apiGet(
            `https://api-faa.my.id/faa/ytmp3?url=${encodeURIComponent(audioUrl)}`,
          );

          const result = audioData?.result;

          if (!audioData?.status || !result?.mp3) {
            throw new Error("No se pudo obtener el audio.");
          }

          await Atlas.sendMessage(
            chatId,
            {
              audio: { url: result.mp3 },
              mimetype: "audio/mpeg",
              contextInfo: {
                externalAdReply: {
                  title: result.title || "YouTube Audio",
                  body: "🎧 YouTube Audio",
                  ...(result.thumbnail
                    ? { thumbnailUrl: result.thumbnail }
                    : {}),
                  mediaType: 2,
                  renderLargerThumbnail: true,
                },
              },
            },
            { quoted: m },
          );

          break;
        }

        case "play":
        case "song":
        case "yt": {
          if (doReact) await doReact("📥");

          const playData = await apiGet(
            `https://api-faa.my.id/faa/ytplay?query=${encodeURIComponent(query)}`,
          );

          const result = playData?.result;

          if (!playData?.status || !result?.mp3) {
            throw new Error("No se pudo encontrar o generar el audio.");
          }

          const {
            title: playTitle,
            author: playAuthor,
            thumbnail: playThumbnail,
            mp3: playMp3,
          } = result;

          let previewMessage;

          try {
            if (playThumbnail) {
              previewMessage = await Atlas.sendMessage(
                chatId,
                {
                  image: { url: playThumbnail },
                  caption:
                    `🎶 *${playTitle || "YouTube"}*\n` +
                    `👤 ${playAuthor || "Desconocido"}\n\n` +
                    `⬇️ Downloading...`,
                },
                { quoted: m },
              );
            }

            await Atlas.sendMessage(
              chatId,
              {
                audio: { url: playMp3 },
                mimetype: "audio/mpeg",
                contextInfo: {
                  externalAdReply: {
                    title: playTitle || "YouTube Audio",
                    body: playAuthor || "YouTube",
                    ...(playThumbnail
                      ? { thumbnailUrl: playThumbnail }
                      : {}),
                    mediaType: 2,
                    renderLargerThumbnail: true,
                  },
                },
              },
              { quoted: m },
            );
          } finally {
            if (previewMessage?.key) {
              try {
                await Atlas.sendMessage(chatId, {
                  delete: previewMessage.key,
                });
              } catch {
                // No interrumpir el envío si falla el borrado de la vista previa.
              }
            }
          }

          break;
        }

        default:
          return m.reply("❌ Comando de YouTube no reconocido.");
      }
    } catch (err) {
      console.error("[YouTube] Error:", err.message);

      await m.reply(
        err.code === "ECONNABORTED"
          ? "⏱️ La API tardó demasiado en responder. Inténtalo otra vez."
          : `❌ Error: ${err.message}`,
      );
    } finally {
      activeChats.delete(chatId);
    }
  },
};
