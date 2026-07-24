import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { TelegramClient, utils } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";

const app = express();
const PORT = toNumber(process.env.PORT, 3000, 1, 65535);

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = (process.env.API_HASH || "").trim();
const TELEGRAM_SESSION = (process.env.TELEGRAM_SESSION || "").trim();
const SOURCE_CHAT = (process.env.SOURCE_CHAT || "").trim();
const TARGET_BOT_USERNAME = normalizeUsername(
  process.env.TARGET_BOT_USERNAME || "toolsfixredupgradeGAARZ_BOT"
);
const TARGET_COMMAND = (process.env.TARGET_COMMAND || "/fix").trim();

const SEND_DELAY_MS = toNumber(process.env.SEND_DELAY_MS, 3000, 1000, 120000);
const JOB_TIMEOUT_MINUTES = toNumber(
  process.env.JOB_TIMEOUT_MINUTES,
  30,
  1,
  24 * 60
);
const DUPLICATE_WINDOW_HOURS = toNumber(
  process.env.DUPLICATE_WINDOW_HOURS,
  24,
  1,
  24 * 365
);
const ALLOW_SUCCESS_WITHOUT_NUMBER = toBoolean(
  process.env.ALLOW_SUCCESS_WITHOUT_NUMBER,
  false
);
const NOTIFY_DUPLICATE = toBoolean(process.env.NOTIFY_DUPLICATE, true);
const SOURCE_MESSAGE_MODE = (process.env.SOURCE_MESSAGE_MODE || "number_only")
  .trim()
  .toLowerCase();

const SUCCESS_PATTERNS = parsePatterns(
  process.env.SUCCESS_PATTERNS ||
    "FIX MERAH SELESAI|EMAIL DIBALAS — SUKSES|EMAIL DIBALAS - SUKSES|BANDING BERHASIL TERKIRIM|BANDING BERHASIL DIKIRIM"
);
const FAILURE_PATTERNS = parsePatterns(
  process.env.FAILURE_PATTERNS ||
    "GAGAL|TIDAK BERHASIL|INVALID|NOMOR TIDAK VALID"
);

const SUCCESS_REPLY =
  process.env.SUCCESS_REPLY || "✅ Nomor {number} sudah beres ditinjau.";
const FAILURE_REPLY =
  process.env.FAILURE_REPLY ||
  "❌ Nomor {number} belum berhasil diproses. Silakan cek kembali atau hubungi admin.";
const TIMEOUT_REPLY =
  process.env.TIMEOUT_REPLY ||
  "⏳ Nomor {number} belum mendapatkan report selesai. Admin perlu cek bot Gaarz.";

const STATE_FILE = path.resolve(process.env.STATE_FILE || "./state.json");

validateEnv();

const client = new TelegramClient(
  new StringSession(TELEGRAM_SESSION),
  API_ID,
  API_HASH,
  {
    connectionRetries: 10,
    autoReconnect: true,
    floodSleepThreshold: 60,
  }
);

let sourceEntity;
let targetEntity;
let sourcePeerId = "";
let targetPeerId = "";
let accountPeerId = "";
let processingQueue = false;
let shuttingDown = false;

const state = {
  version: 1,
  jobs: [],
};

app.get("/", (_req, res) => {
  const active = getActiveJob();
  res.json({
    ok: true,
    service: "telegram-fix-userbot",
    sourceConnected: Boolean(sourcePeerId),
    targetConnected: Boolean(targetPeerId),
    active: active ? maskPhone(active.phone) : null,
    queued: state.jobs.filter((job) => job.status === "queued").length,
  });
});

app.get("/ping", (_req, res) => {
  res.type("text/plain").send("pong");
});

app.get("/health", (_req, res) => {
  const counts = countJobs();
  res.json({
    ok: true,
    connected: client.connected,
    sourcePeerId,
    target: TARGET_BOT_USERNAME ? `@${TARGET_BOT_USERNAME}` : null,
    jobs: counts,
  });
});

await loadState();
await connectTelegram();

client.addEventHandler(handleNewMessage, new NewMessage({}));

app.listen(PORT, () => {
  console.log(`✅ Web server aktif di port ${PORT}`);
  console.log("✅ Endpoint health: /ping dan /health");
});

setInterval(() => {
  void expireTimedOutJob();
}, 30_000).unref();

void processQueue();

async function connectTelegram() {
  await client.connect();

  if (!(await client.isUserAuthorized())) {
    throw new Error(
      "TELEGRAM_SESSION tidak valid. Jalankan npm run session di komputer lokal."
    );
  }

  const me = await client.getMe();
  accountPeerId = String(utils.getPeerId(me));

  sourceEntity = await resolveEntity(SOURCE_CHAT);
  targetEntity = await client.getEntity(TARGET_BOT_USERNAME);

  sourcePeerId = String(utils.getPeerId(sourceEntity));
  targetPeerId = String(utils.getPeerId(targetEntity));

  console.log(
    `✅ Login sebagai ${me.username ? `@${me.username}` : me.firstName || accountPeerId}`
  );
  console.log(`✅ Grup sumber: ${getEntityName(sourceEntity)} (${sourcePeerId})`);
  console.log(`✅ Bot target: @${TARGET_BOT_USERNAME} (${targetPeerId})`);
  console.log("✅ Automation siap menerima nomor.");
}

async function handleNewMessage(event) {
  try {
    const message = event?.message;
    if (!message || !message.id) return;

    const chatId = message.chatId ? String(message.chatId) : "";
    const senderId = message.senderId ? String(message.senderId) : "";
    const text = (message.message || "").trim();

    if (!chatId || !text) return;

    if (chatId === sourcePeerId) {
      // Abaikan pesan yang dikirim akun automation sendiri agar tidak membuat loop.
      if (message.out || senderId === accountPeerId) return;
      await handleSourceMessage(message, text, senderId);
      return;
    }

    if (chatId === targetPeerId) {
      // Hanya proses pesan masuk dari bot target, bukan command kita sendiri.
      if (message.out || senderId === accountPeerId) return;
      await handleTargetMessage(message, text);
    }
  } catch (error) {
    console.error("❌ Gagal memproses pesan Telegram:", error?.message || error);
  }
}

async function handleSourceMessage(message, text, senderId) {
  const phones = extractIndonesianPhones(text);
  if (phones.length === 0) return;

  // Satu pesan sumber dipetakan ke satu nomor agar report tidak tertukar.
  if (!isAcceptedSourceMessage(text, phones)) return;

  const phone = phones[0];
  const duplicate = findRecentJob(phone);

  if (duplicate) {
    if (NOTIFY_DUPLICATE) {
      const duplicateReply =
        duplicate.status === "done"
          ? `✅ Nomor ${phone} sudah pernah selesai ditinjau.`
          : `⏳ Nomor ${phone} masih berada dalam antrean atau sedang diproses.`;

      await safeSendMessage(sourceEntity, duplicateReply, message.id);
    }
    return;
  }

  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    phone,
    sourceMessageId: Number(message.id),
    sourceSenderId: senderId || null,
    status: "queued",
    createdAt: new Date().toISOString(),
    sentAt: null,
    finishedAt: null,
    targetRequestMessageId: null,
    targetReportMessageId: null,
    error: null,
  };

  state.jobs.push(job);
  await saveState();

  console.log(`📥 Masuk antrean: ${maskPhone(phone)}`);
  void processQueue();
}

async function handleTargetMessage(message, text) {
  const active = getActiveJob();
  if (!active) return;

  const reportPhones = extractIndonesianPhones(text);
  const hasMatchingPhone = reportPhones.includes(active.phone);
  const canUseWithoutNumber =
    ALLOW_SUCCESS_WITHOUT_NUMBER && reportPhones.length === 0;

  if (containsPattern(text, SUCCESS_PATTERNS)) {
    if (!hasMatchingPhone && !canUseWithoutNumber) {
      console.log(
        `ℹ️ Report sukses dilewati karena tidak cocok dengan ${maskPhone(active.phone)}.`
      );
      return;
    }

    active.status = "done";
    active.finishedAt = new Date().toISOString();
    active.targetReportMessageId = Number(message.id);
    await saveState();

    await safeSendMessage(
      sourceEntity,
      renderTemplate(SUCCESS_REPLY, active.phone),
      active.sourceMessageId
    );

    console.log(`✅ Selesai ditinjau: ${maskPhone(active.phone)}`);
    await sleep(SEND_DELAY_MS);
    void processQueue();
    return;
  }

  if (containsPattern(text, FAILURE_PATTERNS)) {
    if (!hasMatchingPhone && !canUseWithoutNumber) return;

    active.status = "failed";
    active.finishedAt = new Date().toISOString();
    active.targetReportMessageId = Number(message.id);
    active.error = text.slice(0, 500);
    await saveState();

    await safeSendMessage(
      sourceEntity,
      renderTemplate(FAILURE_REPLY, active.phone),
      active.sourceMessageId
    );

    console.log(`❌ Report gagal: ${maskPhone(active.phone)}`);
    await sleep(SEND_DELAY_MS);
    void processQueue();
  }
}

async function processQueue() {
  if (processingQueue || shuttingDown) return;
  processingQueue = true;
  let next = null;

  try {
    if (getActiveJob()) return;

    next = state.jobs.find((job) => job.status === "queued");
    if (!next) return;

    await sleep(SEND_DELAY_MS);

    // Tandai aktif sebelum request dikirim agar report yang sangat cepat tidak terlewat.
    next.status = "sent";
    next.sentAt = new Date().toISOString();
    next.error = null;
    await saveState();

    const requestText = `${TARGET_COMMAND}\n${next.phone}`;
    const sentMessage = await sendWithFloodWait(() =>
      client.sendMessage(targetEntity, { message: requestText })
    );

    // Report bisa datang sangat cepat dan mengubah status menjadi done.
    // Jangan menimpa status tersebut setelah sendMessage selesai.
    next.targetRequestMessageId = Number(sentMessage.id);
    await saveState();

    console.log(`📤 Dikirim ke @${TARGET_BOT_USERNAME}: ${maskPhone(next.phone)}`);
  } catch (error) {
    console.error("❌ Gagal mengirim antrean:", error?.message || error);

    if (next && next.status === "sent" && !next.targetRequestMessageId) {
      next.status = "queued";
      next.sentAt = null;
      next.error = String(error?.message || error).slice(0, 500);
      await saveState();
    }

    setTimeout(() => void processQueue(), 30_000).unref();
  } finally {
    processingQueue = false;
  }
}

async function expireTimedOutJob() {
  const active = getActiveJob();
  if (!active?.sentAt) return;

  const ageMs = Date.now() - new Date(active.sentAt).getTime();
  const timeoutMs = JOB_TIMEOUT_MINUTES * 60_000;
  if (ageMs < timeoutMs) return;

  active.status = "timeout";
  active.finishedAt = new Date().toISOString();
  active.error = `Tidak ada report selesai dalam ${JOB_TIMEOUT_MINUTES} menit.`;
  await saveState();

  await safeSendMessage(
    sourceEntity,
    renderTemplate(TIMEOUT_REPLY, active.phone),
    active.sourceMessageId
  );

  console.log(`⏳ Timeout: ${maskPhone(active.phone)}`);
  void processQueue();
}

function getActiveJob() {
  return state.jobs.find((job) => job.status === "sent") || null;
}

function isAcceptedSourceMessage(text, phones) {
  if (SOURCE_MESSAGE_MODE === "any") return true;
  if (phones.length !== 1) return false;

  // Default: pesan harus hanya berisi satu nomor, boleh memakai +, spasi,
  // tanda hubung, titik, atau kurung. Ini mencegah nomor dalam obrolan biasa
  // ikut terkirim tanpa sengaja.
  const compact = String(text).replace(/[\s.()+-]/g, "");
  return /^(?:62|0)8\d{7,12}$/.test(compact);
}

function findRecentJob(phone) {
  const cutoff = Date.now() - DUPLICATE_WINDOW_HOURS * 60 * 60 * 1000;
  return (
    [...state.jobs]
      .reverse()
      .find(
        (job) =>
          job.phone === phone &&
          new Date(job.createdAt).getTime() >= cutoff &&
          ["queued", "sent", "done"].includes(job.status)
      ) || null
  );
}

async function safeSendMessage(entity, message, replyTo) {
  return sendWithFloodWait(() =>
    client.sendMessage(entity, {
      message,
      ...(replyTo ? { replyTo: Number(replyTo) } : {}),
      linkPreview: false,
    })
  );
}

async function sendWithFloodWait(action, attempt = 1) {
  try {
    return await action();
  } catch (error) {
    const seconds = Number(error?.seconds || 0);
    const isFloodWait = seconds > 0 || /FLOOD_WAIT/i.test(error?.message || "");

    if (isFloodWait && attempt <= 3) {
      const waitMs = Math.min(Math.max(seconds, 5), 120) * 1000;
      console.warn(`⚠️ Flood wait ${Math.ceil(waitMs / 1000)} detik.`);
      await sleep(waitMs);
      return sendWithFloodWait(action, attempt + 1);
    }

    throw error;
  }
}

async function resolveEntity(value) {
  const cleaned = value.trim();
  if (/^-?\d+$/.test(cleaned)) {
    try {
      return await client.getEntity(BigInt(cleaned));
    } catch {
      // Isi cache dialog lalu cocokkan ID. Berguna untuk grup private.
      const dialogs = await client.getDialogs({ limit: 200 });
      const match = dialogs.find((dialog) => {
        try {
          return String(utils.getPeerId(dialog.entity)) === cleaned;
        } catch {
          return false;
        }
      });
      if (match?.entity) return match.entity;
    }
  }

  return client.getEntity(cleaned.replace(/^@/, ""));
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    state.jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];

    // Jika restart terjadi sesaat sebelum status tersimpan, queued tetap aman diproses.
    console.log(`✅ State dimuat: ${state.jobs.length} job.`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("⚠️ State gagal dibaca, memakai state kosong:", error?.message || error);
    }
    state.jobs = [];
  }
}

async function saveState() {
  const directory = path.dirname(STATE_FILE);
  const tempFile = `${STATE_FILE}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    tempFile,
    JSON.stringify({ version: 1, jobs: state.jobs }, null, 2),
    "utf8"
  );
  await fs.rename(tempFile, STATE_FILE);
}

function extractIndonesianPhones(text) {
  const matches = String(text).match(/(?:\+?62|0)8(?:[\s.()-]?\d){7,12}/g) || [];
  const normalized = matches
    .map((value) => value.replace(/\D/g, ""))
    .map((value) => (value.startsWith("0") ? `62${value.slice(1)}` : value))
    .filter((value) => /^628\d{7,12}$/.test(value));

  return [...new Set(normalized)];
}

function parsePatterns(value) {
  return String(value)
    .split("|")
    .map((pattern) => pattern.trim().toLocaleUpperCase("id-ID"))
    .filter(Boolean);
}

function containsPattern(text, patterns) {
  const upper = String(text).toLocaleUpperCase("id-ID");
  return patterns.some((pattern) => upper.includes(pattern));
}

function normalizeUsername(value) {
  return String(value).trim().replace(/^@/, "");
}

function renderTemplate(template, phone) {
  return String(template).replaceAll("{number}", phone);
}

function countJobs() {
  return state.jobs.reduce((counts, job) => {
    counts[job.status] = (counts[job.status] || 0) + 1;
    return counts;
  }, {});
}

function getEntityName(entity) {
  return (
    entity?.title ||
    entity?.username ||
    [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") ||
    "Unknown"
  );
}

function maskPhone(phone) {
  if (phone.length <= 7) return phone;
  return `${phone.slice(0, 5)}***${phone.slice(-3)}`;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function toNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateEnv() {
  const missing = [];
  if (!Number.isInteger(API_ID) || API_ID <= 0) missing.push("API_ID");
  if (!API_HASH) missing.push("API_HASH");
  if (!TELEGRAM_SESSION) missing.push("TELEGRAM_SESSION");
  if (!SOURCE_CHAT) missing.push("SOURCE_CHAT");
  if (!TARGET_BOT_USERNAME) missing.push("TARGET_BOT_USERNAME");
  if (!TARGET_COMMAND) missing.push("TARGET_COMMAND");

  if (missing.length > 0) {
    console.error(`❌ ENV belum lengkap: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: menutup koneksi...`);

  try {
    await saveState();
    await client.disconnect();
  } catch (error) {
    console.error("Shutdown error:", error?.message || error);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});
