import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export interface Config {
  port: number;
  storageDriver: 'local' | 's3';
  localStorageDir: string;
  s3: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  adminPassword: string;
  sessionSecret: string;
  trustProxy: boolean;
  clientDist: string;
}

export function loadConfig(): Config {
  const driver = env('STORAGE_DRIVER', 'local');
  if (driver !== 'local' && driver !== 's3') throw new Error(`Invalid STORAGE_DRIVER: ${driver}`);
  const sessionSecret = env('SESSION_SECRET');
  if (!sessionSecret) console.warn('[config] SESSION_SECRET is empty; using an insecure development secret.');
  return {
    port: Number(env('PORT', '3001')),
    storageDriver: driver,
    localStorageDir: path.resolve(serverRoot, env('LOCAL_STORAGE_DIR', './data/uploads')),
    s3: {
      endpoint: env('S3_ENDPOINT') || undefined,
      region: env('S3_REGION', 'auto'),
      bucket: env('S3_BUCKET', 'puzzlelove'),
      accessKeyId: env('S3_ACCESS_KEY_ID'),
      secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: env('S3_FORCE_PATH_STYLE', 'true') === 'true',
    },
    adminPassword: env('ADMIN_PASSWORD'),
    sessionSecret: sessionSecret || 'dev-insecure-secret',
    trustProxy: env('TRUST_PROXY', '0') === '1',
    clientDist: path.resolve(serverRoot, env('CLIENT_DIST', '../client/dist')),
  };
}
