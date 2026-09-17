import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { PIECE_COUNT_OPTIONS } from '@puzzlelove/shared';
import type { Config } from './config';
import type { Repo } from './db/repo';
import { ImageError, MAX_UPLOAD_BYTES, processImage } from './images';
import { imageUrl, type RoomManager } from './rooms/RoomManager';
import { IMAGE_KEY_PATTERN, type ImageStorage } from './storage';

const ADMIN_COOKIE = 'pl_admin';
const ADMIN_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export interface AppDeps {
  config: Pick<Config, 'adminPassword' | 'sessionSecret' | 'trustProxy' | 'clientDist'>;
  manager: RoomManager;
  storage: ImageStorage;
  repo: Repo;
  /** Max private rooms created per IP per hour. */
  roomCreateLimit?: number;
}

function sameSecret(a: string, b: string) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function createApp({ config, manager, storage, repo, roomCreateLimit = 10 }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser(config.sessionSecret));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
  });

  const readImage = async (req: Request) => {
    if (!req.file) throw new ImageError('missing_image');
    return processImage(req.file.buffer);
  };

  // ------------------------------------------------------------ public API

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  const createLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: roomCreateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'rate_limited' },
  });

  app.post('/api/rooms', createLimiter, upload.single('image'), async (req, res) => {
    const pieces = Number(req.body?.pieces);
    if (!(PIECE_COUNT_OPTIONS as readonly number[]).includes(pieces)) {
      res.status(400).json({ error: 'invalid_piece_count' });
      return;
    }
    const image = await readImage(req);
    const slug = await manager.createPrivateRoom(image, pieces);
    res.status(201).json({ slug });
  });

  app.get('/api/images/:folder/:file', async (req, res) => {
    const key = `${req.params.folder}/${req.params.file}`;
    if (!IMAGE_KEY_PATTERN.test(key)) {
      res.status(404).end();
      return;
    }
    const data = await storage.get(key);
    if (!data) {
      res.status(404).end();
      return;
    }
    // Keys are unique per upload, so the content never changes.
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('image/webp').send(data);
  });

  // ------------------------------------------------------------ admin API

  const isAdmin = (req: Request) => {
    const value = req.signedCookies?.[ADMIN_COOKIE];
    return typeof value === 'string' && Number(value) > Date.now();
  };

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!isAdmin(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'rate_limited' },
  });

  app.post('/api/admin/login', loginLimiter, (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!config.adminPassword) {
      res.status(503).json({ error: 'admin_disabled' });
      return;
    }
    if (!sameSecret(password, config.adminPassword)) {
      res.status(401).json({ error: 'wrong_password' });
      return;
    }
    res.cookie(ADMIN_COOKIE, String(Date.now() + ADMIN_SESSION_MS), {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: ADMIN_SESSION_MS,
    });
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (_req, res) => {
    res.clearCookie(ADMIN_COOKIE);
    res.json({ ok: true });
  });

  app.get('/api/admin/status', async (req, res) => {
    if (!isAdmin(req)) {
      res.json({ authenticated: false, enabled: !!config.adminPassword });
      return;
    }
    const queue = await repo.listQueue();
    res.json({
      authenticated: true,
      enabled: true,
      global: await manager.globalStatus(),
      queue: queue.map((q) => ({ id: q.id, imageUrl: imageUrl(q.imageKey), createdAt: q.createdAt })),
    });
  });

  app.post('/api/admin/queue', requireAdmin, upload.single('image'), async (req, res) => {
    const image = await readImage(req);
    const item = await manager.addGlobalImage(image);
    res.status(201).json({ id: item.id, imageUrl: imageUrl(item.imageKey), createdAt: item.createdAt });
  });

  app.delete('/api/admin/queue/:id', requireAdmin, async (req, res) => {
    const removed = await manager.removeGlobalImage(String(req.params.id));
    res.status(removed ? 200 : 404).json({ ok: removed });
  });

  app.post('/api/admin/next', requireAdmin, async (_req, res) => {
    await manager.rotateGlobal();
    res.json({ ok: true });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // ------------------------------------------------------------ client app

  const indexHtml = path.join(config.clientDist, 'index.html');
  if (existsSync(indexHtml)) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(indexHtml);
    });
  }

  // ------------------------------------------------------------ errors

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      res.status(code).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'invalid_upload' });
      return;
    }
    if (err instanceof ImageError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[http] unhandled error', err);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}
