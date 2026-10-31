// The generation pipeline: options → silhouette → render → composite (internal resolution).

import { availableParallelism } from 'node:os';
import { createLayout } from './layout.mts';
import { parseHex, toSrgb8 } from './palette.mts';
import { boxBlur, createSilhouette, sampleLowRes, type SilhouetteWithLowRes } from './shape.mts';
import { lightVector, type RenderOptions, type Rgba8 } from './render/context.mts';
import { renderBands } from './render/parallel.mts';

export type Rendered = {
  readonly data: Rgba8;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  readonly corallites: number;
  readonly scale: number; // supersample factor
  readonly periodic: boolean;
};

export type GenerateOptions = RenderOptions & { readonly threads?: number };

/** Put the stone over its drop shadow and background. */
const composite = (
  stone: Rgba8,
  W: number,
  H: number,
  sil: SilhouetteWithLowRes,
  light: readonly [number, number, number],
  background: string,
  shadow: boolean,
): Rgba8 => {
  const bg = background === 'transparent' ? undefined : parseHex(background).map(toSrgb8);
  const low = sil.lowAlpha;
  const shadowMap = shadow
    ? { ...low, data: boxBlur(Float32Array.from(low.data), low.width, low.height, (sil.maxDist * 0.05) / low.factor) }
    : undefined;
  const off = sil.maxDist * 0.07;
  const sdx = Math.round(light[0] * off);
  const sdy = Math.round(light[1] * off);
  const strength = 0.45;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = i * 4;
      const sx = x + sdx;
      const sy = y + sdy;
      const sa = shadowMap && sx >= 0 && sy >= 0 && sx < W && sy < H ? sampleLowRes(shadowMap, sx, sy) * strength : 0;
      // under = shadow (black) over background
      const ua = bg ? 1 : sa;
      const ur = bg ? bg[0]! * (1 - sa) : 0;
      const ug = bg ? bg[1]! * (1 - sa) : 0;
      const ub = bg ? bg[2]! * (1 - sa) : 0;
      const a = stone[o + 3]! / 255;
      const oa = a + ua * (1 - a);
      if (oa <= 0) continue;
      out[o] = (stone[o]! * a + ur * ua * (1 - a)) / oa;
      out[o + 1] = (stone[o + 1]! * a + ug * ua * (1 - a)) / oa;
      out[o + 2] = (stone[o + 2]! * a + ub * ua * (1 - a)) / oa;
      out[o + 3] = Math.round(oa * 255);
    }
  }
  return out;
};

export const generate = async (opts: GenerateOptions, log: (msg: string) => void = () => {}): Promise<Rendered> => {
  const scale = opts.supersample;
  const W = opts.width * scale;
  const H = opts.height * scale;
  const threads = opts.threads ?? availableParallelism();
  const t0 = performance.now();
  // Count corallites once for the summary (workers rebuild the same layout).
  const corallites = createLayout({
    seed: opts.seed,
    cellSize: opts.cellSize * scale,
    regularity: opts.regularity,
    domain: { width: W, height: H, periodic: opts.repeat },
  }).count;
  log(`layout: ${corallites} corallites in ${Math.round(performance.now() - t0)} ms`);
  const silhouette = opts.shape === 'rect' ? undefined : createSilhouette(opts.shape, W, H, opts.seed);
  const t1 = performance.now();
  const stone = await renderBands(opts, silhouette, threads, (f) => log(`render: ${Math.round(f * 100)}%`));
  log(`render: done in ${Math.round(performance.now() - t1)} ms on ${threads} thread(s)`);
  const light = lightVector(opts.lightAzimuth, opts.lightElevation);
  const data = silhouette ? composite(stone, W, H, silhouette, light, opts.background, opts.shadow) : stone;
  return {
    data,
    width: W,
    height: H,
    hasAlpha: silhouette !== undefined && opts.background === 'transparent',
    corallites,
    scale,
    periodic: opts.repeat,
  };
};
