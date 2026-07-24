import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { utils } from "telegram";

const apiId = Number(process.env.API_ID || 0);
const apiHash = (process.env.API_HASH || "").trim();
const session = (process.env.TELEGRAM_SESSION || "").trim();

if (!apiId || !apiHash || !session) {
  console.error("Isi API_ID, API_HASH, dan TELEGRAM_SESSION di file .env terlebih dahulu.");
  process.exit(1);
}

const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
  connectionRetries: 5,
});

await client.connect();
if (!(await client.isUserAuthorized())) {
  console.error("TELEGRAM_SESSION tidak valid atau sudah dicabut.");
  await client.disconnect();
  process.exit(1);
}

console.log("\nDaftar chat yang bisa dipakai sebagai SOURCE_CHAT:\n");
const dialogs = await client.getDialogs({ limit: 100 });

for (const dialog of dialogs) {
  const entity = dialog.entity;
  let id = "unknown";
  try {
    id = String(utils.getPeerId(entity));
  } catch {
    id = String(entity?.id || "unknown");
  }

  const type = entity?.className || "Chat";
  const username = entity?.username ? ` @${entity.username}` : "";
  console.log(`${id}\t${type}\t${dialog.name || "Tanpa nama"}${username}`);
}

console.log("\nCari Pasukan Kodok lalu salin ID-nya ke SOURCE_CHAT.\n");
await client.disconnect();
process.exit(0);
