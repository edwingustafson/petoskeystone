// Downsample and encode with sharp; JPEG XL falls back to the jSquash WASM encoder
// because prebuilt sharp binaries are compiled without libjxl.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { Format } from './options.mts';
import type { Rendered } from './generate.mts';

export type EncodeOptions = {
  readonly format: Format;
  readonly width: number;
  readonly height: number;
  readonly background: string;
  readonly quality: number | undefined;
  readonly effort: number | undefined;
  readonly lossless: boolean;
};

export const DEFAULT_QUALITY: { readonly [K in Format]: number } = { png: 100, jpeg: 90, avif: 60, jxl: 85 };

const encodeJxlWasm = async (img: sharp.Sharp, opts: EncodeOptions): Promise<Buffer> => {
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { default: encode, init } = await import('@jsquash/jxl/encode.js');
  const wasmPath = fileURLToPath(import.meta.resolve('@jsquash/jxl/codec/enc/jxl_enc.wasm'));
  await init(await WebAssembly.compile(await readFile(wasmPath)));
  const imageData = {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
    colorSpace: 'srgb',
  } as unknown as ImageData;
  const out = await encode(imageData, {
    quality: opts.quality ?? DEFAULT_QUALITY.jxl,
    effort: opts.effort ?? 7,
    lossless: opts.lossless,
  });
  return Buffer.from(out);
};

export const jxlBackend = (): 'sharp' | 'jsquash' => (sharp.format.jxl.output.buffer ? 'sharp' : 'jsquash');

/**
 * Downsample to the output size. Tiles are padded by wrapping before the resize
 * and cropped afterwards, so the resampling kernel sees across the seam.
 */
const downsample = async (img: Rendered, width: number, height: number): Promise<sharp.Sharp> => {
  const raw = { width: img.width, height: img.height, channels: 4 } as const;
  if (!img.periodic) return sharp(img.data, { raw }).resize(width, height, { fit: 'fill', kernel: 'lanczos3' });
  const k = 4; // output-pixel padding, ≥ the lanczos3 support
  const p = k * img.scale;
  const padded = await sharp(img.data, { raw })
    .extend({ top: p, bottom: p, left: p, right: p, extendWith: 'repeat' })
    .raw()
    .toBuffer();
  return sharp(padded, { raw: { width: img.width + 2 * p, height: img.height + 2 * p, channels: 4 } })
    .resize(width + 2 * k, height + 2 * k, { fit: 'fill', kernel: 'lanczos3' })
    .extract({ left: k, top: k, width, height });
};

export const encodeImage = async (img: Rendered, opts: EncodeOptions, warn: (msg: string) => void): Promise<Buffer> => {
  const resized = await downsample(img, opts.width, opts.height);
  const quality = opts.quality ?? DEFAULT_QUALITY[opts.format];
  const keepAlpha = img.hasAlpha && opts.format !== 'jpeg';
  if (img.hasAlpha && opts.format === 'jpeg') warn('JPEG has no transparency; flattening onto white (use --background to choose a color)');
  const prepared = keepAlpha
    ? resized
    : opts.format === 'jpeg' && img.hasAlpha
      ? resized.flatten({ background: '#ffffff' })
      : resized.removeAlpha();
  switch (opts.format) {
    case 'png':
      return prepared.png({ compressionLevel: opts.effort ?? 9 }).withIccProfile('srgb').toBuffer();
    case 'jpeg':
      return prepared
        .jpeg({ quality, mozjpeg: true, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' })
        .withIccProfile('srgb')
        .toBuffer();
    case 'avif':
      return prepared.avif({ quality, effort: opts.effort ?? 4, lossless: opts.lossless }).withIccProfile('srgb').toBuffer();
    case 'jxl':
      return jxlBackend() === 'sharp'
        ? prepared.jxl({ quality, effort: opts.effort ?? 7, lossless: opts.lossless }).toBuffer()
        : encodeJxlWasm(prepared, opts);
  }
};
