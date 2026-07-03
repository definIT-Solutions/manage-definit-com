import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { deleteFile } from '../services/storage.js';

export async function contactRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma as PrismaClient;

  // List all contacts (phone_number -> name map for the web UI)
  fastify.get('/', async () => {
    const contacts = await prisma.contact.findMany({ orderBy: { name: 'asc' } });
    return {
      contacts: contacts.map(c => ({ phone_number: c.phoneNumber, name: c.name })),
    };
  });

  // Assign / rename / clear a contact name for a phone number.
  // An empty or whitespace-only name removes the contact mapping.
  fastify.put('/:phoneNumber', async (request: FastifyRequest, reply: FastifyReply) => {
    const { phoneNumber } = request.params as { phoneNumber: string };
    const { name } = (request.body || {}) as { name?: string };
    const trimmed = (name || '').trim();

    if (!trimmed) {
      await prisma.contact.deleteMany({ where: { phoneNumber } });
      return reply.send({ phone_number: phoneNumber, name: null });
    }

    const contact = await prisma.contact.upsert({
      where: { phoneNumber },
      update: { name: trimmed },
      create: { phoneNumber, name: trimmed },
    });
    return reply.send({ phone_number: contact.phoneNumber, name: contact.name });
  });

  // Delete a contact AND all recordings for that phone number (audio files included)
  fastify.delete('/:phoneNumber', async (request: FastifyRequest, reply: FastifyReply) => {
    const { phoneNumber } = request.params as { phoneNumber: string };

    const recordings = await prisma.recording.findMany({
      where: { phoneNumber },
      select: { audioFilePath: true },
    });

    const result = await prisma.recording.deleteMany({ where: { phoneNumber } });
    await prisma.contact.deleteMany({ where: { phoneNumber } });
    await Promise.all(recordings.map(r => deleteFile(r.audioFilePath).catch(() => {})));

    return reply.send({ deleted: true, recordings_deleted: result.count });
  });
}
