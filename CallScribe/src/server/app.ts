import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from './config.js';
import { authRoutes } from './routes/auth.js';
import { recordingRoutes } from './routes/recordings.js';
import { contactRoutes } from './routes/contacts.js';
import { healthRoutes } from './routes/health.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string; displayName: string | null };
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function createApp() {
  const prisma = new PrismaClient();
  await prisma.$connect();

  const app = Fastify({ logger: true });

  // Decorate with prisma
  app.decorate('prisma', prisma);
  app.addHook('onClose', async () => { await prisma.$disconnect(); });

  await app.register(cors, {
    origin: config.nodeEnv === 'development' ? true : false,
    credentials: true,
  });

  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });

  // Auth directly on root instance (no encapsulation issues)
  const expectedApiKey = Buffer.from(config.apiKey);
  app.addHook('onRequest', async (request, reply) => {
    // Skip auth for non-API routes (static files) and health
    if (!request.url.startsWith('/api/')) return;
    if (request.url === '/api/health') return;

    // Bearer token (mobile uploads)
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = Buffer.from(authHeader.slice(7));
      if (expectedApiKey.length === token.length && crypto.timingSafeEqual(expectedApiKey, token)) {
        request.user = { id: 'mobile-client', email: 'mobile@callscribe', displayName: 'Mobile Client' };
        return;
      }
      return reply.code(401).send({ error: 'Invalid API key' });
    }

    // Cloudflare Access (web UI)
    const cfEmail = request.headers['cf-access-authenticated-user-email'] as string;
    if (cfEmail) {
      let user = await prisma.user.findUnique({ where: { email: cfEmail } });
      if (!user) {
        user = await prisma.user.create({ data: { email: cfEmail, displayName: cfEmail.split('@')[0] } });
      }
      request.user = { id: user.id, email: user.email, displayName: user.displayName };
      return;
    }

    // Dev mode fallback
    if (config.nodeEnv === 'development') {
      request.user = { id: 'dev-user', email: 'dev@definit.com', displayName: 'Dev User' };
      return;
    }

    // /api/auth/me returns null user instead of 401 (so frontend knows user is not logged in)
    if (request.url === '/api/auth/me') return;

    return reply.code(401).send({ error: 'Authentication required' });
  });

  // API routes
  await app.register(healthRoutes, { prefix: '/api/health' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(recordingRoutes, { prefix: '/api/recordings' });
  await app.register(contactRoutes, { prefix: '/api/contacts' });

  // Serve static frontend
  // In dev: __dirname = .../src/server → go up 2 to reach dist/client
  // In prod: __dirname = .../dist/server → go up 1 to reach dist/client
  const clientPath = __dirname.includes('src/server') || __dirname.includes('src\\server')
    ? join(__dirname, '../../dist/client')
    : join(__dirname, '../client');

  await app.register(fastifyStatic, { root: clientPath, prefix: '/' });

  // SPA fallback
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  return app;
}
