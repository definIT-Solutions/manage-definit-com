import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { Agent, fetch as undiciFetch } from 'undici';
import { config } from '../config.js';
import { getFilePath } from './storage.js';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const openai = new OpenAI({ apiKey: config.openaiApiKey });

const WHISPER_MAX_SIZE = 24 * 1024 * 1024; // 24MB (leave margin under 25MB limit)
const FORMAT_MODEL = 'claude-opus-4-8';
const DEEPGRAM_TIMEOUT_MS = 1_200_000; // 20 min — long calls hold the connection while Deepgram processes

// Deepgram returns response headers only after processing the whole file, which
// for multi-hour calls exceeds undici's default 300s headersTimeout (surfaces as
// "fetch failed"). This dispatcher raises the header/body timeouts for that call.
const deepgramDispatcher = new Agent({
  headersTimeout: DEEPGRAM_TIMEOUT_MS,
  bodyTimeout: DEEPGRAM_TIMEOUT_MS,
});

// ---------------------------------------------------------------------------
// Result of stage 1 (speech-to-text). `body` is the verbatim transcript that
// becomes the source of truth — Claude never regenerates it, only annotates.
// ---------------------------------------------------------------------------
interface SttResult {
  body: string;        // verbatim transcript (diarized + timestamped if available)
  diarized: boolean;   // true when speaker labels are present
  engine: string;      // provenance string for the footer
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtTs(seconds: number): string {
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('.m4a') || filePath.endsWith('.mp4')) return 'audio/mp4';
  if (filePath.endsWith('.mp3')) return 'audio/mpeg';
  if (filePath.endsWith('.wav')) return 'audio/wav';
  if (filePath.endsWith('.flac')) return 'audio/flac';
  return 'application/octet-stream';
}

function compressToMp3(wavPath: string): string {
  const mp3Path = wavPath.replace(/\.[^.]+$/, '.mp3');
  execFileSync(
    'ffmpeg',
    ['-y', '-i', wavPath, '-ac', '1', '-ab', '64k', '-ar', '16000', mp3Path],
    { timeout: 120000, stdio: 'pipe' },
  );
  return mp3Path;
}

// ---------------------------------------------------------------------------
// Stage 1a — Deepgram (primary): telephony-tuned nova-3 with diarization.
// One request handles the whole file; builds a timestamped, speaker-labelled
// verbatim transcript from the utterance stream.
// ---------------------------------------------------------------------------
async function deepgramTranscribe(fullPath: string, keyterms: string[]): Promise<SttResult> {
  const params = new URLSearchParams({
    model: 'nova-3',
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
    utterances: 'true',
    language: 'en',
  });
  for (const term of keyterms) {
    if (term && term.trim()) params.append('keyterm', term.trim());
  }

  const audio = fs.readFileSync(fullPath);
  // Use undici's own fetch (matching module instance as the Agent) so the raised
  // header/body timeouts are honoured — Node's global fetch ignores a foreign dispatcher.
  const resp = await undiciFetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.deepgramApiKey}`,
      'Content-Type': contentTypeFor(fullPath),
    },
    body: audio,
    signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS),
    dispatcher: deepgramDispatcher,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Deepgram ${resp.status}: ${detail.slice(0, 500)}`);
  }

  const data: any = await resp.json();
  const utterances: any[] = data?.results?.utterances ?? [];
  if (!Array.isArray(utterances) || utterances.length === 0) {
    throw new Error('Deepgram returned no utterances');
  }

  const lines = utterances.map((u) => {
    const spk = typeof u.speaker === 'number' ? u.speaker : 0;
    const text = String(u.transcript ?? '').trim();
    // Bold the label + blank line between utterances so Markdown renderers
    // (marked in email, the custom formatter in the web UI) keep each turn on
    // its own line instead of collapsing single newlines into one wall of text.
    return `**[${fmtTs(Number(u.start) || 0)}] Speaker ${spk}:** ${text}`;
  });

  return { body: lines.join('\n\n'), diarized: true, engine: 'Deepgram nova-3 (diarized)' };
}

// ---------------------------------------------------------------------------
// Stage 1b — Whisper (fallback): plain text, no diarization. Compresses first
// if over the API size limit. Only used if Deepgram is unavailable or errors.
// ---------------------------------------------------------------------------
async function whisperTranscribe(fullPath: string): Promise<SttResult> {
  const stats = fs.statSync(fullPath);
  let fileToSend = fullPath;
  let tempMp3: string | null = null;

  if (stats.size > WHISPER_MAX_SIZE) {
    tempMp3 = compressToMp3(fullPath);
    fileToSend = tempMp3;
  }

  try {
    const file = fs.createReadStream(fileToSend);
    const text = (await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'text',
    })) as unknown as string;
    return { body: String(text).trim(), diarized: false, engine: 'OpenAI Whisper (no diarization)' };
  } finally {
    if (tempMp3 && fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3);
  }
}

export async function speechToText(
  audioFilePath: string,
  keyterms: string[] = [],
): Promise<SttResult> {
  const fullPath = getFilePath(audioFilePath);

  if (config.deepgramApiKey) {
    try {
      return await deepgramTranscribe(fullPath, keyterms);
    } catch (err: any) {
      console.error(`Deepgram STT failed, falling back to Whisper: ${err?.message ?? err}`);
    }
  }
  return whisperTranscribe(fullPath);
}

// ---------------------------------------------------------------------------
// Stage 2 — Claude formatting. Bounded output only (summary / participants /
// action items). It never re-emits the transcript, so nothing is truncated or
// paraphrased. The verbatim STT body is appended beneath, unchanged.
// ---------------------------------------------------------------------------
export async function formatHeader(
  stt: SttResult,
  phoneNumber: string,
  direction: string,
  startedAt: Date,
  durationSeconds: number | null,
  contactName?: string | null,
): Promise<string> {
  const other = contactName ? `${contactName} (${phoneNumber})` : phoneNumber;
  const speakerNote = stt.diarized
    ? 'The transcript below is diarized: each line is tagged "Speaker 0", "Speaker 1", etc. Determine which speaker index is the device owner and which is the other party.'
    : 'The transcript below is NOT diarized (single stream of text). Infer speaker turns where possible.';

  const stream = anthropic.messages.stream({
    model: FORMAT_MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are a call-transcript analyst. Below is a verbatim transcript of a recorded phone call. Do NOT reproduce or rewrite the transcript — it is stored separately, verbatim. Produce only the analysis sections requested.

Call metadata:
- Other party: ${other}
- Direction: ${direction}
- Date: ${startedAt.toISOString()}
- Duration: ${durationSeconds ? `${durationSeconds} seconds (~${Math.round(durationSeconds / 60)} min)` : 'unknown'}
- Device owner (recorder): Robert McNicholas, DefinIT

${speakerNote}

Verbatim transcript:
${stt.body}

Produce exactly these sections in Markdown, and nothing else:

## Summary
A faithful 4-8 sentence summary of what the call was about and what was decided.

## Participants
${stt.diarized
  ? 'Map each Speaker index to a real identity, e.g. "- Speaker 0 — Robert McNicholas (device owner)" and "- Speaker 1 — ' + (contactName || 'the other party') + '". Base this on the phone number, who called whom, and the content.'
  : 'Best-effort identification of who is speaking, based on the phone number and content.'}

## Action Items
A bullet list of concrete commitments, follow-ups, or next steps with who owns each. If none, write "None identified."`,
      },
    ],
  });

  const message = await stream.finalMessage();
  const block = message.content[0];
  return block && block.type === 'text' ? block.text.trim() : '';
}

// ---------------------------------------------------------------------------
// Pull the "## Action Items" section out of a finished transcript. Returns ''
// when the section is missing or is a "None identified…" line (incl. variants
// like "None identified - transcript unintelligible") — nothing actionable.
// ---------------------------------------------------------------------------
function actionItemsBlock(transcript: string): string {
  if (!transcript) return '';
  const idx = transcript.search(/^##\s*Action Items\s*$/im);
  if (idx === -1) return '';
  const after = transcript.slice(idx).replace(/^##\s*Action Items\s*$/im, '');
  const next = after.search(/^##\s/m);
  const body = (next === -1 ? after : after.slice(0, next)).trim();
  if (!body || /^\s*[-*]?\s*none identified/i.test(body)) return '';
  return body;
}

// Raw bullet block — used to seed the CallScribe per-recording Notes field.
export function extractActionItems(transcript: string): string {
  return actionItemsBlock(transcript);
}

// Individual action items as clean one-line strings — used for the Notes-app
// checklist (one checkbox per item). Strips bullets/bold and joins wrapped lines.
export function parseActionItems(transcript: string): string[] {
  const block = actionItemsBlock(transcript);
  if (!block) return [];
  return block
    .split(/\n(?=\s*[-*]\s)/)
    .map((raw) => raw.trim().replace(/^[-*]\s+/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Orchestrator. Returns: <Claude header> + verbatim transcript + provenance.
// ---------------------------------------------------------------------------
export async function transcribe(
  audioFilePath: string,
  phoneNumber: string,
  direction: string,
  startedAt: Date,
  durationSeconds: number | null,
  contactName?: string | null,
): Promise<string> {
  const keyterms = [contactName || '', 'DefinIT', 'McNicholas'].filter(Boolean);
  const stt = await speechToText(audioFilePath, keyterms);
  const header = await formatHeader(stt, phoneNumber, direction, startedAt, durationSeconds, contactName);

  return [
    header,
    '',
    '## Transcript',
    stt.body,
    '',
    `_Transcribed via ${stt.engine} + Claude ${FORMAT_MODEL}._`,
  ].join('\n');
}
