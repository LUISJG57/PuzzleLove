import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_SIDE = 2000;
const MIN_SIDE = 200;

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
}

export class ImageError extends Error {}

export function randomId(length = 12): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Normalizes an upload: applies EXIF rotation, limits size, converts to WebP. */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  let pipeline;
  try {
    pipeline = sharp(input, { limitInputPixels: 80_000_000 }).rotate();
    const meta = await pipeline.metadata();
    if (!meta.width || !meta.height) throw new ImageError('invalid_image');
  } catch (err) {
    if (err instanceof ImageError) throw err;
    throw new ImageError('invalid_image');
  }
  const { data, info } = await pipeline
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 86 })
    .toBuffer({ resolveWithObject: true });
  if (Math.min(info.width, info.height) < MIN_SIDE) throw new ImageError('image_too_small');
  return { data, width: info.width, height: info.height };
}

/** Colorful placeholder used for the global puzzle until the admin uploads one. */
export async function createDefaultGlobalImage(): Promise<ProcessedImage> {
  const w = 1600;
  const h = 1200;
  const hearts: string[] = [];
  const colors = ['#f43f5e', '#fb7185', '#f97316', '#facc15', '#a855f7', '#ec4899', '#38bdf8'];
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 60; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const s = 30 + rnd() * 110;
    const c = colors[Math.floor(rnd() * colors.length)];
    const r = Math.floor(rnd() * 60 - 30);
    hearts.push(
      `<path transform="translate(${x} ${y}) rotate(${r}) scale(${s / 100})" fill="${c}" fill-opacity="${0.55 + rnd() * 0.45}"
        d="M0 30 C0 -10 -50 -10 -50 25 C-50 55 -15 70 0 90 C15 70 50 55 50 25 C50 -10 0 -10 0 30Z"/>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fde68a"/>
        <stop offset="0.5" stop-color="#fbcfe8"/>
        <stop offset="1" stop-color="#c4b5fd"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    ${hearts.join('\n')}
    <text x="${w / 2}" y="${h / 2 + 50}" text-anchor="middle" font-family="Arial Black, Arial, sans-serif"
      font-size="180" font-weight="900" fill="#ffffff" stroke="#be185d" stroke-width="10" paint-order="stroke">PuzzleLove</text>
  </svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
