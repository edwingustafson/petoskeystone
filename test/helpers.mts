import sharp from 'sharp';
import { generate, type GenerateOptions } from '../src/generate.mts';
import { encodeImage } from '../src/encode.mts';
import type { Format } from '../src/options.mts';

export const baseOptions: GenerateOptions = {
  style: 'realistic',
  finish: 'polished',
  palette: 'natural',
  colors: [],
  width: 192,
  height: 160,
  shape: 'rect',
  background: 'transparent',
  shadow: true,
  repeat: false,
  cellSize: 48,
  regularity: 0.6,
  wobble: 0.3,
  lightAzimuth: 135,
  lightElevation: 45,
  seed: 'test-seed',
  supersample: 1,
};

export const encodeOpts = (o: GenerateOptions, format: Format) => ({
  format,
  width: o.width,
  height: o.height,
  background: o.background,
  quality: undefined,
  effort: format === 'png' ? 1 : format === 'jxl' ? 1 : 0,
  lossless: false,
});

/** Render, encode to PNG, decode back to raw RGBA at output size. */
export const renderRaw = async (o: GenerateOptions): Promise<{ data: Buffer; width: number; height: number; channels: number }> => {
  const png = await encodeImage(await generate(o), encodeOpts(o, 'png'), () => {});
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
};
