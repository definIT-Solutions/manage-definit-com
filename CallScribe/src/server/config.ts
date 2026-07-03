function env(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3020', 10),
  apiKey: env('API_KEY'),
  anthropicApiKey: env('ANTHROPIC_API_KEY'),
  openaiApiKey: env('OPENAI_API_KEY'),
  // Deepgram is the primary STT engine (diarization + telephony-tuned). Optional
  // so a missing key never crashes boot; transcription falls back to Whisper.
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
  // Connection string to the Notes app DB. Optional — when set, each transcribed
  // call also logs a Notes-app card (action items as a checklist). Empty = skip.
  notesDatabaseUrl: process.env.NOTES_DATABASE_URL || '',
  smtpHost: env('SMTP_HOST', 'smtp.office365.com'),
  smtpPort: parseInt(env('SMTP_PORT', '587'), 10),
  smtpSecure: process.env.SMTP_SECURE === 'true',
  smtpUser: env('SMTP_USER'),
  smtpPass: env('SMTP_PASS'),
  emailFrom: env('EMAIL_FROM', process.env.SMTP_USER || ''),
  emailTo: env('EMAIL_TO', 'r.mcnicholas@definit.com'),
  storageDir: env('STORAGE_DIR', '/app/storage'),
};
