import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { saveFile, getFilePath, deleteFile } from '../services/storage.js';
import { transcribe, extractActionItems } from '../services/transcription.js';
import { sendTranscriptEmail } from '../services/email.js';

export async function recordingRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma as PrismaClient;

  // Upload (mobile API)
  fastify.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    // Parse all multipart parts (fields may come after file)
    const fields: Record<string, string> = {};
    let fileBuffer: Buffer | null = null;
    let filename = 'recording.wav';

    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk);
        fileBuffer = Buffer.concat(chunks);
        filename = part.filename || filename;
      } else {
        fields[part.fieldname] = part.value as string;
      }
    }

    if (!fileBuffer) return reply.code(400).send({ error: 'No file uploaded' });

    fastify.log.info({ parsedFields: fields, filename }, 'Upload received');

    const phoneNumber = fields.phone_number;
    const direction = fields.direction;
    const startedAt = fields.started_at;
    const durationSeconds = fields.duration_seconds;

    if (!phoneNumber || !direction || !startedAt) {
      return reply.code(400).send({ error: `Missing: phone_number=${phoneNumber}, direction=${direction}, started_at=${startedAt}` });
    }

    const id = crypto.randomUUID();
    const ext = filename.split('.').pop() || 'wav';
    const storedFilename = `${id}.${ext}`;
    const { size } = await saveFile(storedFilename, fileBuffer);

    const recording = await prisma.recording.create({
      data: {
        id, phoneNumber, direction,
        startedAt: new Date(startedAt),
        durationSeconds: durationSeconds ? parseInt(durationSeconds, 10) : null,
        audioFilePath: storedFilename,
        audioFileSize: BigInt(size),
        transcriptStatus: 'pending',
      },
    });

    processRecording(prisma, id, fastify.log).catch(err => {
      fastify.log.error({ err, recordingId: id }, 'Transcription failed');
    });

    return reply.code(201).send({
      id: recording.id,
      status: recording.transcriptStatus,
      created_at: recording.createdAt.toISOString(),
    });
  });

  // List recordings (web UI)
  fastify.get('/', async (request: FastifyRequest) => {
    const { page = '1', limit = '50', phone_number, search, from, to } = request.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (phone_number) where.phoneNumber = phone_number;

    // Date range filter (from/to are YYYY-MM-DD, inclusive of the whole day)
    if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(`${from}T00:00:00.000`);
      if (to) where.startedAt.lte = new Date(`${to}T23:59:59.999`);
    }

    if (search) {
      // Match phone numbers whose assigned contact name contains the search term
      const matchedContacts = await prisma.contact.findMany({
        where: { name: { contains: search, mode: 'insensitive' } },
        select: { phoneNumber: true },
      });
      where.OR = [
        { phoneNumber: { contains: search } },
        { transcript: { contains: search, mode: 'insensitive' } },
        { notes: { contains: search, mode: 'insensitive' } },
        ...(matchedContacts.length
          ? [{ phoneNumber: { in: matchedContacts.map(c => c.phoneNumber) } }]
          : []),
      ];
    }

    const [recordings, total] = await Promise.all([
      prisma.recording.findMany({
        where, orderBy: { startedAt: 'desc' }, skip, take: limitNum,
        select: {
          id: true, phoneNumber: true, direction: true, startedAt: true,
          durationSeconds: true, transcriptStatus: true, emailSent: true,
          notes: true, createdAt: true,
        },
      }),
      prisma.recording.count({ where }),
    ]);

    // Resolve contact names for the phone numbers in this page
    const numbers = [...new Set(recordings.map(r => r.phoneNumber))];
    const contacts = numbers.length
      ? await prisma.contact.findMany({ where: { phoneNumber: { in: numbers } } })
      : [];
    const nameByNumber = new Map(contacts.map(c => [c.phoneNumber, c.name]));

    return {
      recordings: recordings.map(r => ({
        id: r.id,
        phone_number: r.phoneNumber,
        contact_name: nameByNumber.get(r.phoneNumber) || null,
        direction: r.direction,
        started_at: r.startedAt.toISOString(),
        duration_seconds: r.durationSeconds,
        transcript_status: r.transcriptStatus,
        email_sent: r.emailSent,
        has_notes: !!r.notes,
        created_at: r.createdAt.toISOString(),
      })),
      total, page: pageNum, limit: limitNum,
    };
  });

  // Get single recording with full transcript
  fastify.get('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const recording = await prisma.recording.findUnique({ where: { id } });
    if (!recording) return reply.code(404).send({ error: 'Not found' });

    return {
      id: recording.id,
      phone_number: recording.phoneNumber,
      direction: recording.direction,
      started_at: recording.startedAt.toISOString(),
      duration_seconds: recording.durationSeconds,
      transcript_status: recording.transcriptStatus,
      transcript: recording.transcript,
      transcript_error: recording.transcriptError,
      email_sent: recording.emailSent,
      email_sent_at: recording.emailSentAt?.toISOString() || null,
      notes: recording.notes,
      created_at: recording.createdAt.toISOString(),
      updated_at: recording.updatedAt.toISOString(),
    };
  });

  // Stream audio file
  fastify.get('/:id/audio', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const recording = await prisma.recording.findUnique({
      where: { id },
      select: { audioFilePath: true, audioMimeType: true },
    });
    if (!recording) return reply.code(404).send({ error: 'Not found' });

    const fullPath = getFilePath(recording.audioFilePath);
    const fs = await import('fs');
    if (!fs.existsSync(fullPath)) return reply.code(404).send({ error: 'Audio file not found' });

    const stat = fs.statSync(fullPath);
    const mimeType = recording.audioFilePath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';

    reply.header('Content-Type', mimeType);
    reply.header('Content-Length', stat.size);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Disposition', `inline; filename="${recording.audioFilePath}"`);

    const stream = fs.createReadStream(fullPath);
    return reply.send(stream);
  });

  // Status endpoint (mobile API)
  fastify.get('/:id/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const recording = await prisma.recording.findUnique({
      where: { id },
      select: { id: true, transcriptStatus: true, emailSent: true, emailSentAt: true, transcriptError: true },
    });
    if (!recording) return reply.code(404).send({ error: 'Not found' });
    return {
      id: recording.id,
      transcript_status: recording.transcriptStatus,
      email_sent: recording.emailSent,
      email_sent_at: recording.emailSentAt?.toISOString() || null,
      error: recording.transcriptError,
    };
  });

  // Delete a single recording (web UI) — removes the audio file too
  fastify.delete('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const recording = await prisma.recording.findUnique({
      where: { id },
      select: { audioFilePath: true },
    });
    if (!recording) return reply.code(404).send({ error: 'Not found' });

    await prisma.recording.delete({ where: { id } });
    await deleteFile(recording.audioFilePath).catch(() => {});
    return reply.send({ deleted: true });
  });

  // Update notes (web UI)
  fastify.patch('/:id/notes', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { notes } = request.body as { notes: string };
    const recording = await prisma.recording.update({
      where: { id },
      data: { notes },
      select: { id: true, notes: true, updatedAt: true },
    });
    return { id: recording.id, notes: recording.notes, updated_at: recording.updatedAt.toISOString() };
  });

  // Get unique phone numbers (for sidebar filter)
  fastify.get('-meta/phone-numbers', async () => {
    const result = await prisma.recording.groupBy({
      by: ['phoneNumber'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    });
    const contacts = await prisma.contact.findMany();
    const nameByNumber = new Map(contacts.map(c => [c.phoneNumber, c.name]));
    return {
      phone_numbers: result.map(r => ({
        phone_number: r.phoneNumber,
        name: nameByNumber.get(r.phoneNumber) || null,
        count: r._count.id,
      })),
    };
  });
}

async function processRecording(prisma: PrismaClient, recordingId: string, log: any) {
  await prisma.recording.update({ where: { id: recordingId }, data: { transcriptStatus: 'processing' } });

  try {
    const recording = await prisma.recording.findUniqueOrThrow({ where: { id: recordingId } });
    const transcript = await transcribe(
      recording.audioFilePath, recording.phoneNumber,
      recording.direction, recording.startedAt, recording.durationSeconds,
    );

    await prisma.recording.update({
      where: { id: recordingId },
      data: { transcriptStatus: 'completed', transcript },
    });

    // Seed the Notes field with the call's action items — but only when Notes is
    // still empty, so we never overwrite anything a human has typed.
    const actionItems = extractActionItems(transcript);
    if (actionItems && (!recording.notes || recording.notes.trim() === '')) {
      await prisma.recording.update({
        where: { id: recordingId },
        data: { notes: `Action items:\n${actionItems}` },
      });
    }

    try {
      await sendTranscriptEmail(recording.phoneNumber, recording.direction, recording.startedAt, transcript);
      await prisma.recording.update({
        where: { id: recordingId },
        data: { emailSent: true, emailSentAt: new Date() },
      });
    } catch (emailErr: any) {
      log.error({ err: emailErr, recordingId }, 'Email failed');
      await prisma.recording.update({
        where: { id: recordingId },
        data: { emailError: emailErr.message },
      });
    }
  } catch (err: any) {
    log.error({ err, recordingId }, 'Transcription failed');
    await prisma.recording.update({
      where: { id: recordingId },
      data: { transcriptStatus: 'failed', transcriptError: err.message },
    });
  }
}
