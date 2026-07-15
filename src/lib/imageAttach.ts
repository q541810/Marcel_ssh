/** Pending attachment before send (object URL for preview + base64 for upload). */
export interface PendingImage {
  id: string;
  previewUrl: string;
  /** data:image/webp;base64,... or raw base64 */
  dataUrl: string;
}

export const MAX_ATTACH_IMAGES = 5;
export const MAX_IMAGE_EDGE = 2048;
export const TARGET_IMAGE_BYTES = 5 * 1024 * 1024;

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取图片'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('图片编码失败'));
      },
      type,
      quality,
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

/** Compress image: max edge 2048, prefer WebP ~0.8, shrink quality if >5MB. */
export async function compressImageFile(file: Blob): Promise<{ dataUrl: string; previewUrl: string }> {
  const img = await loadImageFromBlob(file);
  let { width, height } = img;
  const maxEdge = Math.max(width, height);
  if (maxEdge > MAX_IMAGE_EDGE) {
    const scale = MAX_IMAGE_EDGE / maxEdge;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 不可用');
  ctx.drawImage(img, 0, 0, width, height);

  let quality = 0.8;
  let blob: Blob | null = null;
  for (let i = 0; i < 6; i++) {
    try {
      blob = await canvasToBlob(canvas, 'image/webp', quality);
    } catch {
      blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    }
    if (blob.size <= TARGET_IMAGE_BYTES) break;
    quality = Math.max(0.4, quality - 0.1);
  }
  if (!blob) throw new Error('图片压缩失败');

  const dataUrl = await blobToDataUrl(blob);
  const previewUrl = URL.createObjectURL(blob);
  return { dataUrl, previewUrl };
}

export function isImageFile(file: File | Blob): boolean {
  if ('type' in file && file.type) {
    return file.type.startsWith('image/');
  }
  return false;
}

export async function filesToPendingImages(
  files: FileList | File[],
  existingCount: number,
): Promise<{ images: PendingImage[]; rejected: string | null }> {
  const list = Array.from(files).filter(isImageFile);
  if (list.length === 0) {
    return { images: [], rejected: '仅支持图片文件' };
  }
  const room = MAX_ATTACH_IMAGES - existingCount;
  if (room <= 0) {
    return { images: [], rejected: `最多 ${MAX_ATTACH_IMAGES} 张图片` };
  }
  const take = list.slice(0, room);
  const images: PendingImage[] = [];
  for (const file of take) {
    try {
      const { dataUrl, previewUrl } = await compressImageFile(file);
      images.push({
        id: crypto.randomUUID(),
        previewUrl,
        dataUrl,
      });
    } catch {
      // skip broken files
    }
  }
  if (images.length === 0) {
    return { images: [], rejected: '图片处理失败' };
  }
  const overflow = list.length > room;
  return {
    images,
    rejected: overflow ? `最多 ${MAX_ATTACH_IMAGES} 张，已忽略多余文件` : null,
  };
}

export function revokePendingImages(images: PendingImage[]) {
  for (const img of images) {
    if (img.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(img.previewUrl);
    }
  }
}

/** Restore a pending attachment from a persisted data URL (e.g. after rollback). */
export function pendingImageFromDataUrl(dataUrl: string): PendingImage {
  return {
    id: crypto.randomUUID(),
    previewUrl: dataUrl,
    dataUrl,
  };
}
