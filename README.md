# Telegram FIX Userbot Automation — GitHub + Render

Versi ini dipakai karena target `@toolsfixredupgradeGAARZ_BOT` adalah **bot pribadi milik orang lain**, bukan grup.

Automation login menggunakan akun Telegram biasa milik Anda, kemudian menjalankan alur:

1. Member mengirim nomor di grup **Pasukan Kodok**.
2. Automation memasukkan nomor ke antrean.
3. Akun Telegram automation mengirim ke bot Gaarz dengan format persis:

```text
/fix
6285371713331
```

4. Automation menunggu report sukses dari bot Gaarz yang memuat nomor tersebut.
5. Automation kembali ke Pasukan Kodok dan reply langsung ke pesan asli:

```text
✅ Nomor 6285371713331 sudah beres ditinjau.
```

Nomor diproses **satu per satu** agar report dari bot Gaarz tidak tertukar. Secara default, automation hanya mengambil pesan yang isinya satu nomor saja agar nomor dalam obrolan biasa tidak ikut terkirim.

## File proyek

```text
index.js
package.json
generate-session.js
list-dialogs.js
.env.example
.gitignore
render.yaml
README.md
```

## 1. Persiapan akun Telegram

Gunakan akun Telegram yang:

- Sudah masuk ke grup Pasukan Kodok.
- Sudah membuka `@toolsfixredupgradeGAARZ_BOT`.
- Sudah menekan **Start** atau mengirim `/start` ke bot Gaarz satu kali.
- Tidak sedang dibatasi oleh Telegram.

Sebaiknya gunakan akun khusus operasional, bukan akun pribadi utama.

## 2. Buat API ID dan API HASH

1. Buka `https://my.telegram.org`.
2. Login menggunakan nomor Telegram automation.
3. Buka **API development tools**.
4. Buat aplikasi.
5. Simpan `api_id` dan `api_hash`.

Jangan upload `API_HASH` ke GitHub.

## 3. Buat TELEGRAM_SESSION di komputer lokal

Pastikan Node.js 20 atau lebih baru sudah terpasang.

Ekstrak proyek, lalu buka terminal pada folder proyek:

```bash
npm install
```

Salin `.env.example` menjadi `.env`, lalu isi minimal:

```env
API_ID=12345678
API_HASH=isi_api_hash
```

Jalankan:

```bash
npm run session
```

Masukkan:

- Nomor Telegram lengkap.
- Kode login yang dikirim Telegram.
- Password 2FA jika akun menggunakannya.

Terminal akan menampilkan String Session. Salin hasilnya ke:

```env
TELEGRAM_SESSION=hasil_string_session
```

**Session mempunyai akses ke akun Telegram. Jangan kirim ke orang lain dan jangan upload `.env` ke GitHub.**

## 4. Cari ID grup Pasukan Kodok

Setelah `.env` berisi `API_ID`, `API_HASH`, dan `TELEGRAM_SESSION`, jalankan:

```bash
npm run dialogs
```

Cari baris grup Pasukan Kodok, contohnya:

```text
-1001234567890    Channel    PASUKAN KODOK
```

Masukkan ID tersebut ke `.env`:

```env
SOURCE_CHAT=-1001234567890
```

Grup publik juga bisa memakai username, tetapi ID lebih disarankan.

## 5. Tes lokal

Isi konfigurasi penting di `.env`:

```env
API_ID=12345678
API_HASH=isi_api_hash
TELEGRAM_SESSION=isi_string_session
SOURCE_CHAT=-1001234567890
TARGET_BOT_USERNAME=toolsfixredupgradeGAARZ_BOT
TARGET_COMMAND=/fix
```

Jalankan:

```bash
npm start
```

Kirim nomor di Pasukan Kodok:

```text
6285371713331
```

Pastikan akun automation mengirim ke bot Gaarz:

```text
/fix
6285371713331
```

Ketika bot Gaarz mengirim report seperti:

```text
FIX MERAH SELESAI
6285371713331 — Terkirim!
```

Automation akan reply ke pesan sumber.

## 6. Upload ke GitHub

Upload file berikut:

```text
index.js
package.json
generate-session.js
list-dialogs.js
.env.example
.gitignore
render.yaml
README.md
```

Jangan upload:

```text
.env
state.json
node_modules
```

## 7. Deploy ke Render

1. Pilih **New Web Service**.
2. Hubungkan repository GitHub.
3. Build Command:

```text
npm install
```

4. Start Command:

```text
npm start
```

5. Health Check Path:

```text
/ping
```

Atau gunakan `render.yaml` melalui Render Blueprint.

## 8. Environment Variables di Render

Wajib:

```env
API_ID=12345678
API_HASH=isi_api_hash
TELEGRAM_SESSION=isi_string_session
SOURCE_CHAT=-1001234567890
TARGET_BOT_USERNAME=toolsfixredupgradeGAARZ_BOT
TARGET_COMMAND=/fix
```

Konfigurasi tambahan tersedia di `.env.example`. Default `SOURCE_MESSAGE_MODE=number_only`; ubah menjadi `any` hanya apabila nomor memang dikirim bersama teks lain.

## 9. Pola report sukses

Default:

```env
SUCCESS_PATTERNS=FIX MERAH SELESAI|EMAIL DIBALAS — SUKSES|EMAIL DIBALAS - SUKSES|BANDING BERHASIL TERKIRIM|BANDING BERHASIL DIKIRIM
```

Report hanya dianggap sukses saat:

- Pesan berasal dari chat pribadi bot Gaarz.
- Memuat salah satu pola sukses.
- Memuat nomor yang sama dengan job aktif.

Jika report sukses bot Gaarz tidak pernah menampilkan nomor, ubah:

```env
ALLOW_SUCCESS_WITHOUT_NUMBER=true
```

Opsi tersebut lebih berisiko salah mencocokkan report, sehingga biarkan `false` jika nomor selalu tampil.

## 10. Antrean dan timeout

Automation hanya mengirim satu nomor, kemudian menunggu report selesai sebelum mengirim nomor berikutnya.

Default timeout:

```env
JOB_TIMEOUT_MINUTES=30
```

Ketika timeout, automation reply ke pesan asli dan melanjutkan antrean berikutnya.

## 11. Penyimpanan state

Default:

```env
STATE_FILE=./state.json
```

Pada Render Free, file lokal dapat hilang ketika redeploy atau instance diganti. Untuk penyimpanan lebih stabil, pasang Render Persistent Disk lalu gunakan contoh path:

```env
STATE_FILE=/var/data/state.json
```

Mount path disk harus sesuai dengan pengaturan Render.

## 12. UptimeRobot

Gunakan monitor HTTP(s):

```text
https://NAMA-APP.onrender.com/ping
```

Respons normal:

```text
pong
```

## Catatan penting

- Jangan menjalankan dua instance dengan session yang sama.
- Jangan mengirim nomor massal; automation sudah memakai antrean dan jeda.
- Jangan membagikan `TELEGRAM_SESSION`, `API_HASH`, kode login, atau password 2FA.
- Bot Gaarz bukan milik proyek ini, sehingga perubahan format report atau pembatasan dari bot tersebut dapat memerlukan penyesuaian `SUCCESS_PATTERNS`.
- Pengujian live hanya bisa dilakukan menggunakan akun Telegram dan akses ke bot Gaarz milik Anda.
