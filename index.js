import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { TelegramClient, utils } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, EditedMessage } from "telegram/events/index.js";

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

const AUTO_CLICK_JOIN_CHECK = toBoolean(
  process.env.AUTO_CLICK_JOIN_CHECK,
  true
);
const JOIN_CHECK_DELAY_MS = toNumber(
  process.env.JOIN_CHECK_DELAY_MS,
  2000,
  500,
  30000
);
const JOIN_CHECK_MAX_ATTEMPTS = toNumber(
  process.env.JOIN_CHECK_MAX_ATTEMPTS,
  3,
  1,
  10
);
const JOIN_BUTTON_FETCH_RETRIES = toNumber(
  process.env.JOIN_BUTTON_FETCH_RETRIES,
  5,
  1,
  15
);
const JOIN_BUTTON_FETCH_INTERVAL_MS = toNumber(
  process.env.JOIN_BUTTON_FETCH_INTERVAL_MS,
  1000,
  250,
  10000
);
const ACCESS_DENIED_PATTERNS = parsePatterns(
  process.env.ACCESS_DENIED_PATTERNS ||
    "AKSES DITOLAK|WAJIB JOIN|JOIN 3 CHANNEL DULU"
);
const JOIN_CHECK_BUTTON_PATTERNS = parsePatterns(
  process.env.JOIN_CHECK_BUTTON_PATTERNS ||
    "SUDAH JOIN SEMUA|CEK ULANG"
);

const AUTO_START_AFTER_VERIFY = toBoolean(
  process.env.AUTO_START_AFTER_VERIFY,
  true
);
const VERIFY_SUCCESS_PATTERNS = parsePatterns(
  process.env.VERIFY_SUCCESS_PATTERNS ||
    "VERIFIKASI BERHASIL|KETIK /START UNTUK MULAI"
);
const VERIFY_START_DELAY_MS = toNumber(
  process.env.VERIFY_START_DELAY_MS,
  1500,
  500,
  30000
);
const RETRY_FIX_AFTER_VERIFY = toBoolean(
  process.env.RETRY_FIX_AFTER_VERIFY,
  true
);
const RETRY_FIX_DELAY_MS = toNumber(
  process.env.RETRY_FIX_DELAY_MS,
  2500,
  500,
  60000
);
const VERIFY_RETRY_MAX = toNumber(
  process.env.VERIFY_RETRY_MAX,
  2,
  1,
  5
);

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
  version: 3,
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

client.addEventHandler(handleTelegramMessage, new NewMessage({}));
client.addEventHandler(handleTelegramMessage, new EditedMessage({}));

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

async function handleTelegramMessage(event) {
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
    joinCheckAttempts: 0,
    joinCheckMessageId: null,
    lastJoinCheckAt: null,
    verifyAttempts: 0,
    lastVerifyAt: null,
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

  if (await maybeHandleVerificationSuccess(message, text, active)) {
    return;
  }

  if (await maybeClickJoinCheck(message, text, active)) {
    return;
  }

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

async function maybeHandleVerificationSuccess(message, text, active) {
  if (!AUTO_START_AFTER_VERIFY) return false;
  if (!containsPattern(text, VERIFY_SUCCESS_PATTERNS)) return false;

  const attempts = Number(active.verifyAttempts || 0);
  if (attempts >= VERIFY_RETRY_MAX) {
    console.warn(
      `⚠️ Batas verifikasi ulang tercapai untuk ${maskPhone(active.phone)}.`
    );
    return true;
  }

  const now = Date.now();
  const lastVerifyAt = active.lastVerifyAt
    ? new Date(active.lastVerifyAt).getTime()
    : 0;

  // Hindari event NewMessage/EditedMessage memicu rangkaian yang sama dua kali.
  if (now - lastVerifyAt < 10_000) return true;

  active.verifyAttempts = attempts + 1;
  active.lastVerifyAt = new Date().toISOString();
  await saveState();

  try {
    await sleep(VERIFY_START_DELAY_MS);
    await sendWithFloodWait(() =>
      client.sendMessage(targetEntity, { message: "/start" })
    );
    console.log(
      `▶️ /start otomatis dikirim setelah verifikasi untuk ${maskPhone(active.phone)}.`
    );

    if (RETRY_FIX_AFTER_VERIFY) {
      await sleep(RETRY_FIX_DELAY_MS);
      const requestText = `${TARGET_COMMAND}\n${active.phone}`;
      const sentMessage = await sendWithFloodWait(() =>
        client.sendMessage(targetEntity, { message: requestText })
      );
      active.targetRequestMessageId = Number(sentMessage.id);
      await saveState();
      console.log(
        `🔄 /fix dikirim ulang setelah verifikasi untuk ${maskPhone(active.phone)}.`
      );
    }
  } catch (error) {
    active.verifyAttempts = attempts;
    active.lastVerifyAt = null;
    await saveState();
    console.error(
      `❌ Gagal melanjutkan setelah verifikasi untuk ${maskPhone(active.phone)}:`,
      error?.message || error
    );
  }

  return true;
}

async function maybeClickJoinCheck(message, text, active) {
  if (!AUTO_CLICK_JOIN_CHECK) return false;

  const accessDenied = containsPattern(text, ACCESS_DENIED_PATTERNS);
  if (!accessDenied) return false;

  const now = Date.now();
  const lastClickAt = active.lastJoinCheckAt
    ? new Date(active.lastJoinCheckAt).getTime()
    : 0;
  const sameMessage = Number(active.joinCheckMessageId) === Number(message.id);

  // Hindari klik ganda ketika NewMessage dan EditedMessage datang berdekatan.
  if (sameMessage && now - lastClickAt < 10_000) {
    return true;
  }

  const attempts = Number(active.joinCheckAttempts || 0);
  if (attempts >= JOIN_CHECK_MAX_ATTEMPTS) {
    console.warn(
      `⚠️ Batas klik cek ulang tercapai untuk ${maskPhone(active.phone)}. Pastikan akun automation sudah join semua channel wajib.`
    );
    return true;
  }

  // Reply markup kadang belum ikut ter-hydrate pada event pertama. Tunggu,
  // fetch ulang pesan, lalu cari tombol beberapa kali sebelum menyerah.
  await sleep(JOIN_CHECK_DELAY_MS);

  let found = null;
  for (let retry = 1; retry <= JOIN_BUTTON_FETCH_RETRIES; retry += 1) {
    found = await findJoinCheckButton(message, retry > 1);
    if (found?.button) break;

    console.log(
      `🔎 Tombol cek ulang belum terbaca (${retry}/${JOIN_BUTTON_FETCH_RETRIES}) untuk ${maskPhone(active.phone)}.`
    );

    if (retry < JOIN_BUTTON_FETCH_RETRIES) {
      await sleep(JOIN_BUTTON_FETCH_INTERVAL_MS);
    }
  }

  if (!found?.button) {
    const labels = found?.labels?.length ? found.labels.join(" | ") : "tidak ada";
    console.warn(
      `⚠️ Akses ditolak untuk ${maskPhone(active.phone)}, tetapi tombol cek ulang tidak ditemukan. Tombol terbaca: ${labels}`
    );
    return true;
  }

  // Simpan penanda sebelum callback dikirim supaya event edit yang datang cepat
  // tidak memicu klik kedua untuk pesan yang sama.
  active.joinCheckAttempts = attempts + 1;
  active.joinCheckMessageId = Number(message.id);
  active.lastJoinCheckAt = new Date().toISOString();
  await saveState();

  try {
    const result = await sendWithFloodWait(async () => {
      try {
        // Cara utama: klik wrapper MessageButton langsung.
        return await found.button.click();
      } catch (firstError) {
        // Fallback: klik melalui CustomMessage berdasarkan teks tombol.
        if (found.ownerMessage?.click && found.label) {
          console.warn(
            `⚠️ Klik langsung gagal, mencoba fallback message.click(): ${firstError?.message || firstError}`
          );
          return found.ownerMessage.click({ text: found.label });
        }
        throw firstError;
      }
    });

    const callbackText = String(result?.message || "").trim();
    console.log(
      `🔁 Tombol "${found.label}" diklik (${active.joinCheckAttempts}/${JOIN_CHECK_MAX_ATTEMPTS}) untuk ${maskPhone(active.phone)}${callbackText ? ` — ${callbackText}` : ""}`
    );
  } catch (error) {
    // Izinkan event berikutnya mencoba lagi jika callback benar-benar gagal.
    active.joinCheckAttempts = attempts;
    active.joinCheckMessageId = null;
    active.lastJoinCheckAt = null;
    await saveState();

    console.error(
      `❌ Gagal klik tombol cek ulang untuk ${maskPhone(active.phone)}:`,
      error?.message || error
    );
  }

  return true;
}

async function findJoinCheckButton(message, forceRefetch = false) {
  const messageCandidates = [];

  if (!forceRefetch) {
    messageCandidates.push(message);
  }

  try {
    const fetched = await client.getMessages(targetEntity, {
      ids: [Number(message.id)],
    });
    const fullMessage = Array.isArray(fetched) ? fetched[0] : fetched;
    if (fullMessage) messageCandidates.push(fullMessage);
  } catch (error) {
    console.warn("⚠️ Gagal fetch ulang pesan tombol:", error?.message || error);
  }

  if (forceRefetch) {
    messageCandidates.push(message);
  }

  const allLabels = [];

  for (const candidateMessage of messageCandidates) {
    if (!candidateMessage) continue;

    let rows = candidateMessage.buttons;
    let flatButtons = Array.isArray(rows) ? rows.flat().filter(Boolean) : [];

    // getButtons() adalah fallback resmi ketika property buttons belum siap.
    if (flatButtons.length === 0 && candidateMessage.getButtons) {
      try {
        rows = await candidateMessage.getButtons();
        flatButtons = Array.isArray(rows) ? rows.flat().filter(Boolean) : [];
      } catch (error) {
        console.warn("⚠️ Gagal membaca tombol pesan:", error?.message || error);
      }
    }

    for (const button of flatButtons) {
      const label = String(button?.text || "").trim();
      if (label) allLabels.push(label);

      const normalizedLabel = normalizeForMatch(label);
      const matches = JOIN_CHECK_BUTTON_PATTERNS.some((pattern) =>
        normalizedLabel.includes(normalizeForMatch(pattern))
      );

      // Tombol join channel adalah URL; tombol cek ulang harus callback.
      if (matches && !button?.url) {
        return {
          button,
          label,
          ownerMessage: candidateMessage,
          labels: [...new Set(allLabels)],
        };
      }
    }
  }

  return {
    button: null,
    label: "",
    ownerMessage: null,
    labels: [...new Set(allLabels)],
  };
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
    JSON.stringify({ version: 2, jobs: state.jobs }, null, 2),
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

function normalizeForMatch(value) {
  return String(value)
    .toLocaleUpperCase("id-ID")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
