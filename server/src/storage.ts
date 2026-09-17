import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Config } from './config';

/** Keys look like "rooms/abc123.webp" or "global/xyz.webp". */
export const IMAGE_KEY_PATTERN = /^(rooms|global)\/[A-Za-z0-9_-]{1,80}\.webp$/;

export interface ImageStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export class LocalStorage implements ImageStorage {
  constructor(private readonly root: string) {}

  private file(key: string) {
    if (!IMAGE_KEY_PATTERN.test(key)) throw new Error(`Invalid image key: ${key}`);
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer) {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async get(key: string) {
    try {
      return await readFile(this.file(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
}

export class S3Storage implements ImageStorage {
  private readonly client: S3Client;

  constructor(private readonly cfg: Config['s3']) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async put(key: string, data: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: data, ContentType: contentType }),
    );
  }

  async get(key: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (err instanceof NoSuchKey || (err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}

export function createStorage(config: Config): ImageStorage {
  return config.storageDriver === 's3' ? new S3Storage(config.s3) : new LocalStorage(config.localStorageDir);
}
