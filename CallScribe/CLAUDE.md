# CallScribe — Call Recording, Transcription & Notes

## Purpose

Android app that auto-records phone calls for specific tracked numbers, uploads recordings to a backend service for transcription via Whisper + Claude, emails formatted transcripts, and provides a web UI for viewing transcripts and adding notes.

## Architecture

```
Android App (Pixel/Samsung/etc)
  │  Records calls via AudioRecord
  │  Uploads WAV to backend via HTTPS
  │
  ▼
Cloudflare Access (service token auth)
  │
  ▼
manage.definit.com/callscribe/*
  │
  ▼
Caddy → CallScribe container (:3020)
  │
  ├─ POST /api/recordings    ← Android upload (Bearer auth)
  │    ├─ Save WAV to disk
  │    ├─ OpenAI Whisper → raw transcript
  │    ├─ Claude → formatted transcript (summary + action items)
  │    └─ SMTP → email to r.mcnicholas@definit.com
  │
  ├─ GET /api/recordings     ← Web UI (CF Access auth)
  ├─ GET /api/recordings/:id ← View transcript
  ├─ PATCH /api/recordings/:id/notes ← Add/edit notes
  │
  └─ Static React frontend   ← Web UI at /callscribe/
       ├─ Recordings list (filter by number, search)
       ├─ Transcript viewer (formatted markdown)
       └─ Notes editor (auto-save)
```

## Components

### Backend (this directory)

| Component | Details |
|-----------|---------|
| **Runtime** | Node.js 20, Fastify 5, TypeScript (ES modules) |
| **Database** | PostgreSQL 16 via Prisma ORM |
| **Frontend** | React 18, Vite, React Router, lucide-react icons |
| **Transcription** | OpenAI Whisper API (speech-to-text) → Claude Sonnet (formatting) |
| **Email** | Nodemailer via SMTP2GO (mail.smtp2go.com:2525) |
| **Storage** | Docker volume at `/app/storage/recordings/` |
| **Auth** | Dual: Bearer API key (Android) + Cloudflare Access header (web) |

### Android App (`C:\Users\RobertMcNicholas\Projects\CallScribe\android\`)

| Component | Details |
|-----------|---------|
| **Language** | Kotlin, minSdk 33, targetSdk 35 |
| **UI** | Jetpack Compose, Material 3 |
| **DI** | Hilt |
| **Database** | Room (tracked numbers + recording history) |
| **Upload** | Retrofit + OkHttp, WorkManager (reliable, survives reboots) |
| **Capture** | Google Call Notes auto-records; app ingests via root (`FermatSyncWorker` + `RootFermat`, libsu). `CallMonitorService` (TelephonyCallback) only triggers the sync on call-end. See "Recording Architecture". |
| **Credentials** | EncryptedSharedPreferences |

## Audio Source Behavior by Device

| Device | VOICE_CALL | VOICE_COMMUNICATION | MIC |
|--------|-----------|---------------------|-----|
| Pixel (non-rooted) | Blocked | Near-side only | Near-side only |
| Pixel (rooted/Magisk) | Both sides | Both sides | Near-side |
| Samsung Galaxy | Usually works (both sides) | Sometimes both | Near-side |
| Other OEMs | Varies | Varies | Near-side |

**Rooting requirement:** Pixel devices purchased from Verizon have locked bootloaders and cannot be rooted. Pixels purchased from the Google Store can be rooted via Magisk for full VOICE_CALL access.

> **Superseded (2026-06-08):** The app no longer records audio itself. On Android 16, `VOICE_CALL` capture requires `CAPTURE_AUDIO_OUTPUT` (protection level `signature|privileged|role`), which a sideloaded app cannot be granted — even systemized — so it always fell back to MIC + forced speakerphone (poor audio, not discreet). The app now ingests **Google Call Notes** recordings instead (see next section). The diagram and table above describe the legacy capture path, kept for reference.

## Recording Architecture — Google Call Notes Ingestion (CURRENT, 2026-06-08)

The Pixel's built-in **Google Call Notes** auto-records tracked calls (clean both-side audio, system-level, plays Google's own recording announcement to both parties). The CallScribe app reads those recordings **on-device via root** and pushes them through the existing upload → Whisper → email pipeline. No PC, no speakerphone, no system modification.

```
Google Call Notes auto-records call  →  .m4a in the dialer's private storage
        │  (/data/user/0/com.google.android.dialer/files/fermat_files/<startMs>.m4a)
        ▼
CallScribe app (rooted) reads it via libsu:
   su -t <dialer_pid> -c "base64 <file>"   (namespace trick; base64 = binary-safe over libsu)
        │  maps number/direction from the call log (filename ms == call_log date, ±5s)
        ▼
existing UploadWorker  →  POST /api/recordings  →  Whisper → Claude → email + web UI
```

**Key Android files** (`app/src/main/java/com/definit/callscribe/`):
- `util/RootFermat.kt` — root reads of Call Notes (`pidof` dialer, `su -t <pid>` to `stat`/`base64` the `.m4a`). Uses `libsu` (`com.github.topjohnwu.libsu:core`, via Jitpack).
- `worker/FermatSyncWorker.kt` (HiltWorker) — lists recordings, skips ≤ baseline `since_ts` (SharedPreferences `fermat_sync`, anchored to activation time so pre-existing recordings already on the server are ignored), dedupes (`recordingDao.countByStartedAt`), maps via call log, copies the audio in, enqueues `UploadWorker`. Trigger: on call-end (`CallMonitorService`, 25 s delay) + 15-minute periodic backstop. Idempotent.
- `service/CallMonitorService.kt` — stripped of AudioRecord; now only triggers the sync on `CALL_STATE_IDLE`.
- `CallScribeApp.kt` — libsu config (no `FLAG_REDIRECT_STDERR` — would corrupt the base64 stream) + baseline + periodic schedule. `MainActivity.kt` warms up the Magisk grant in the foreground.

**Requires** Magisk superuser granted to the app (prompted once on first launch; uid was 10405). No reboot, no `/system` changes.

## Dev access to the phone (jump host)

The phone is USB-tethered to **jax-dt01** (Robert's Windows desktop). To build/inspect/drive it remotely:
- SSH into jax-dt01 as the local account **`definit.jump`** (key-only). Azure AD accounts can't do SSH publickey auth on Windows OpenSSH, hence a dedicated local admin account.
- `adb` is not on PATH there — full path: `C:\Users\RobertMcNicholas\AppData\Local\Android\Sdk\platform-tools\adb.exe`.
- Build the APK on jax-dt01 (`gradlew.bat assembleDebug`; `JAVA_HOME` = jdk-17, `sdk.dir` in `local.properties`).
- **Signature note:** the APK signs with jax-dt01's debug keystore, which differs from the original April install → `adb install -r` fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Must `adb uninstall` then `adb install` (wipes app config + tracked numbers — re-enter in Settings + re-add numbers).

## Database Schema

### PostgreSQL (`callscribe` database)

**recordings** table:
- `id` (UUID, PK) — recording identifier
- `phone_number` (text) — E.164 format (+1XXXXXXXXXX)
- `direction` (text) — "incoming" or "outgoing"
- `started_at` (timestamp) — call start time
- `duration_seconds` (int) — call duration
- `audio_file_path` (text) — filename in storage volume
- `audio_file_size` (bigint) — file size in bytes
- `transcript_status` (text) — pending → processing → completed / failed
- `transcript` (text) — formatted markdown transcript
- `transcript_error` (text) — error message if transcription failed
- `email_sent` (boolean) — whether transcript was emailed
- `email_sent_at` (timestamp) — when email was sent
- `email_error` (text) — SMTP error if email failed
- `notes` (text) — user-added notes via web UI
- `created_at`, `updated_at` (timestamps)

**users** table:
- `id` (UUID, PK)
- `email` (text, unique) — from Cloudflare Access header
- `display_name` (text)

**contacts** table — maps a phone number to a display name (applies to all recordings of that number):
- `phone_number` (text, PK) — E.164, matches `recordings.phone_number`
- `name` (text) — assigned contact name
- `created_at`, `updated_at` (timestamps)

### Android Room (`callscribe.db`)

**tracked_numbers** — phone numbers to auto-record
**recordings** — local recording history + upload status

## API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/recordings` | Bearer | Upload recording (multipart: audio + metadata) |
| GET | `/api/recordings` | CF Access / Bearer | List recordings (pagination; `search` matches number/transcript/notes/contact name; filter by `phone_number`, `from`/`to` date range). Each item includes `contact_name`. |
| GET | `/api/recordings/:id` | CF Access / Bearer | Get recording with full transcript |
| GET | `/api/recordings/:id/status` | Bearer | Check transcription status (mobile polling) |
| DELETE | `/api/recordings/:id` | CF Access | Delete a recording (DB row + audio file) |
| PATCH | `/api/recordings/:id/notes` | CF Access | Update notes |
| GET | `/api/recordings-meta/phone-numbers` | CF Access | Unique phone numbers with counts + contact `name` (sidebar) |
| GET | `/api/contacts` | CF Access | List all contact name mappings |
| PUT | `/api/contacts/:phoneNumber` | CF Access | Assign/rename contact name (empty `name` clears it) |
| DELETE | `/api/contacts/:phoneNumber` | CF Access | Delete contact + ALL its recordings (audio files included) |
| GET | `/api/health` | None | Health check |
| GET | `/api/auth/me` | CF Access | Current user info |

## Web UI

Three-column Zendesk-style layout matching RecurringTasks and Notes:
- **Icon Rail** (48px) — shared across all manage.definit.com apps (Home, RecurringTasks, Notes, CallScribe)
- **Sidebar** (260px) — All Recordings + filter by phone number
- **Main** — recordings list or transcript detail view with notes editor

PhoneCall icon from lucide-react in the icon rail.

## File Structure

```
/opt/docker/CallScribe/
├── CLAUDE.md                           # This file
├── Dockerfile
├── package.json
├── tsconfig.json / tsconfig.server.json
├── vite.config.ts
├── prisma/schema.prisma
├── scripts/start.sh
├── src/
│   ├── client/                         # React frontend (Vite)
│   │   ├── index.html
│   │   ├── main.tsx                    # BrowserRouter basename="/callscribe"
│   │   ├── styles.css
│   │   ├── App.tsx                     # Layout + routing
│   │   ├── api/client.ts              # API_BASE='/callscribe/api'
│   │   ├── components/shared/
│   │   │   └── SharedIconRail.tsx     # Includes CallScribe icon
│   │   └── pages/
│   │       ├── RecordingsView.tsx      # Recording list
│   │       └── RecordingDetail.tsx     # Transcript + notes editor
│   └── server/                         # Fastify backend
│       ├── index.ts                    # Entry point
│       ├── app.ts                      # Fastify setup, static serving, auth
│       ├── config.ts                   # Environment variables
│       ├── middleware/auth.ts          # Dual auth (Bearer + CF Access)
│       ├── routes/
│       │   ├── recordings.ts          # Upload, list, detail, notes, phone-numbers
│       │   ├── auth.ts                # /api/auth/me
│       │   └── health.ts             # /api/health
│       └── services/
│           ├── transcription.ts       # Whisper STT + Claude formatting
│           ├── email.ts               # SMTP2GO email
│           └── storage.ts            # File storage helpers
```

## Cloudflare Access

- **Service Token** for Android app: CF-Access-Client-Id + CF-Access-Client-Secret headers
- **Service Auth policy** on manage.definit.com application allows the "callscribe" service token
- Web UI users authenticate via standard Cloudflare Access (@definit.com email)

## Development

```bash
# Backend local dev
cd /opt/docker/CallScribe
npm run dev:server    # Fastify on :3020
npm run dev:client    # Vite on :5180 (proxies /callscribe/api to :3020)

# Build
npm run build         # Builds client (Vite) + server (tsc)

# Rebuild container
cd /opt/docker && docker compose up -d --build callscribe

# View logs
docker logs manage_callscribe --tail 50 -f

# Database
docker exec -it manage_postgres psql -U callscribe -d callscribe
```

## Android App Build

```bash
# Build (from C:\Users\RobertMcNicholas\Projects\CallScribe\android\)
export ANDROID_HOME="/c/Users/RobertMcNicholas/AppData/Local/Android/Sdk"
export JAVA_HOME="/c/Program Files/Microsoft/jdk-17.0.18.8-hotspot"
./gradlew assembleDebug

# Install via ADB
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Known Issues / Status

- **Call Notes ingestion LIVE (2026-06-08)** — rooted Pixel 10 Pro XL: Google Call Notes auto-records tracked calls; the app reads them via root and uploads. Verified end-to-end (record → upload → Whisper → email). This replaced in-app AudioRecord capture.
- **In-app AudioRecord retired** — `VOICE_CALL` needs `CAPTURE_AUDIO_OUTPUT` (signature|privileged|role), ungrantable to a sideloaded app on Android 16; MIC+speakerphone worked but forced speaker + poor audio. See "Recording Architecture" above.
- **App depends on root + Call Notes** — if an OTA wipes Magisk, ingestion pauses until re-rooted (disable Settings → Developer options → Automatic system updates). Call Notes must stay enabled/auto-recording the tracked contacts.
- **SMTP** — Using SMTP2GO (mail.smtp2go.com:2525). M365 direct SMTP was rejected.
- **Transcription pipeline working** — Whisper + Claude produce formatted transcripts with summaries and action items.
- **Upload pipeline working** — Android WorkManager reliably uploads with exponential backoff and CF Access service token auth.
- **Verizon Pixel 9 Pro XL** — bootloader locked, cannot be rooted; unusable for recording. The Google-Store Pixel 10 Pro XL (rooted) is the recording device.

## TODO

- [x] Root Pixel 10 Pro XL with Magisk
- [x] Both-side audio — solved via Google Call Notes ingestion (not VOICE_CALL)
- [x] Test SMTP2GO email delivery end-to-end
- [ ] Auto-cleanup the on-phone `.m4a` copies in the app's files dir after successful upload
- [ ] Add recording playback to web UI
- [ ] Add auto-cleanup of old audio files server-side (90-day retention)
- [ ] Rotate the OpenAI key + CF service-token secret that were shared in chat on 2026-06-08
