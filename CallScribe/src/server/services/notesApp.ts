import pg from 'pg';
import crypto from 'crypto';
import { config } from '../config.js';
import { parseActionItems } from './transcription.js';

// The Notes app (manage.definit.com/#notes) stores one owner. Cards are logged
// against Robert's user. Action items become checklist items (tickable).
const NOTES_USER_ID = 'cmntuku3u000037adp0w85nsk'; // r.mcnicholas@definit.com
const RECORDING_BASE = 'https://manage.definit.com/callscribe/recording/';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// startedAt is a timestamp-without-tz; Prisma hands it back as a UTC Date whose
// UTC fields are the stored wall-clock values — read them with getUTC* so the
// displayed time matches what the CallScribe UI shows.
function clock(d: Date): string {
  let h = d.getUTCHours();
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${h}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ap}`;
}
function longWhen(d: Date): string { return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} · ${clock(d)}`; }
function shortWhen(d: Date): string { return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${clock(d)}`; }
function duration(s: number | null): string { if (!s) return ''; const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; }

interface CallLike {
  id: string;
  phoneNumber: string;
  direction: string;
  startedAt: Date;
  durationSeconds: number | null;
}

// Best-effort: log a Notes-app card for a transcribed call. Never throws in a
// way that should break transcription — callers wrap it. No-op when the Notes
// DB isn't configured or the call has no action items.
export async function logCallToNotesApp(rec: CallLike, transcript: string, contactName?: string | null): Promise<'created' | 'skipped-nodb' | 'skipped-noitems' | 'skipped-dup'> {
  if (!config.notesDatabaseUrl) return 'skipped-nodb';
  const items = parseActionItems(transcript);
  if (!items.length) return 'skipped-noitems';

  const client = new pg.Client({ connectionString: config.notesDatabaseUrl });
  await client.connect();
  try {
    // Idempotent: one card per recording (the recording id lives in the link).
    const dup = await client.query('SELECT 1 FROM "Note" WHERE "userId" = $1 AND content LIKE $2 LIMIT 1', [NOTES_USER_ID, `%${rec.id}%`]);
    if (dup.rowCount) return 'skipped-dup';

    const caller = contactName ? `${contactName} (${rec.phoneNumber})` : rec.phoneNumber;
    const link = RECORDING_BASE + rec.id;
    const content = `Caller: ${caller} · ${rec.direction}\nWhen: ${longWhen(rec.startedAt)} · ${duration(rec.durationSeconds)}\nRecording + transcript: ${link}`;
    const title = `📞 ${contactName || rec.phoneNumber} · ${shortWhen(rec.startedAt)}`;

    const sortRes = await client.query('SELECT COALESCE(MAX("sortOrder"), -1) + 1 AS s FROM "Note" WHERE "userId" = $1 AND archived = false AND trashed = false', [NOTES_USER_ID]);
    const sortOrder: number = sortRes.rows[0].s;
    const noteId = crypto.randomUUID();
    const now = new Date();

    await client.query(
      'INSERT INTO "Note" (id, "userId", title, content, color, pinned, archived, trashed, visibility, "sortOrder", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,false,false,false,$6,$7,$8,$8)',
      [noteId, NOTES_USER_ID, title, content, 'default', 'private', sortOrder, now],
    );
    for (let i = 0; i < items.length; i++) {
      await client.query(
        'INSERT INTO "ChecklistItem" (id, "noteId", text, checked, "sortOrder", "createdAt", "updatedAt") VALUES ($1,$2,$3,false,$4,$5,$5)',
        [crypto.randomUUID(), noteId, items[i], i, now],
      );
    }
    return 'created';
  } finally {
    await client.end();
  }
}
