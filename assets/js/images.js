/**
 * Photo handling: everything happens in the browser. Pictures from a phone
 * camera are 3-5 MB each, which would bloat plants.json and blow past
 * localStorage, so each one is drawn to a canvas, scaled down and re-encoded
 * as a JPEG before it is ever stored.
 */

const MAX_EDGE = 1000;
const QUALITY = 0.72;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export async function fileToDataUrl(file) {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error(`${file ? file.name : 'That file'} is not an image.`);
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`${file.name} is larger than 25 MB — please pick a smaller picture.`);
  }

  const bitmap = await loadBitmap(file);
  if (!bitmap.width || !bitmap.height || bitmap.width < 8 || bitmap.height < 8) {
    // A 0x0 SVG or a 1px tracking pixel would otherwise become a blank photo.
    throw new Error(`${file.name} does not contain a usable picture.`);
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // transparent PNGs would otherwise go black as JPEG
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (typeof bitmap.close === 'function') bitmap.close();

  return canvas.toDataURL('image/jpeg', QUALITY);
}

function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    // Honours EXIF orientation where the browser supports it.
    return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => loadViaImg(file));
  }
  return loadViaImg(file);
}

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not read ${file.name}.`)); };
    img.src = url;
  });
}

/** Rough byte size of a data URL, for the "this is getting big" warning. */
export function dataUrlBytes(dataUrl) {
  const i = dataUrl.indexOf(',');
  if (i < 0) return 0;
  return Math.round(((dataUrl.length - i - 1) * 3) / 4);
}
