const MAX_SIDE = 2400;
const MAX_BYTES = 15 * 1024 * 1024;

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Reads an image in the browser and shrinks big photos before upload,
 * so phones don't send 10 MB files over mobile data.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Formats the browser can't decode (e.g. HEIC on some browsers): let the server try.
    return { blob: file, width: 0, height: 0 };
  }
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  if (scale === 1 && file.size <= MAX_BYTES / 3 && /^image\/(jpeg|png|webp)$/.test(file.type)) {
    bitmap.close();
    return { blob: file, width, height };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  return { blob: blob ?? file, width: canvas.width, height: canvas.height };
}

export async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? 'generic';
  } catch {
    return res.status === 413 ? 'file_too_large' : 'generic';
  }
}
