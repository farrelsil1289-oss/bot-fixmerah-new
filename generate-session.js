import "dotenv/config";
import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const rawApiId = process.env.API_ID || (await input.text("API_ID: "));
const apiHash = process.env.API_HASH || (await input.text("API_HASH: "));
const apiId = Number(rawApiId);

if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash.trim()) {
  console.error("API_ID atau API_HASH tidak valid.");
  process.exit(1);
}

const client = new TelegramClient(new StringSession(""), apiId, apiHash.trim(), {
  connectionRetries: 5,
});

console.log("\nLogin memakai akun Telegram yang akan menjalankan automation.");
console.log("Kode login dikirim oleh Telegram. Jangan berikan kodenya kepada siapa pun.\n");

await client.start({
  phoneNumber: async () => input.text("Nomor Telegram lengkap, contoh +62812...: "),
  phoneCode: async () => input.text("Kode login Telegram: "),
  password: async () => input.text("Password 2FA (Enter jika tidak ada): "),
  onError: (error) => console.error("Login error:", error?.message || error),
});

const me = await client.getMe();
const session = client.session.save();

console.log(`\nLogin berhasil sebagai ${me.username ? `@${me.username}` : me.firstName || me.id}.`);
console.log("\nSalin nilai di bawah ke TELEGRAM_SESSION di Render:\n");
console.log(session);
console.log("\nJangan upload session ini ke GitHub dan jangan kirim ke orang lain.\n");

await client.disconnect();
process.exit(0);
