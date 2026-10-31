// Hash-based 2D gradient noise with optional periodicity (for seamless tiles).

import { seedInt } from './rng.mts';

/** Pixel domain; when `periodic`, all noise wraps exactly at width × height. */
export type Domain = { readonly width: number; readonly height: number; readonly periodic: boolean };

/** Returns roughly [-1, 1]. */
export type Noise2 = (x: number, y: number) => number;

const GRAD_X = Float64Array.from({ length: 16 }, (_, i) => Math.cos((i * Math.PI) / 8));
const GRAD_Y = Float64Array.from({ length: 16 }, (_, i) => Math.sin((i * Math.PI) / 8));

const hash = (ix: number, iy: number, s: number): number => {
  const h0 = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + s) | 0;
  const h1 = Math.imul(h0 ^ (h0 >>> 13), 1274126177);
  return (h1 ^ (h1 >>> 16)) & 15;
};

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** One octave of gradient noise with features roughly `featurePx` pixels across. */
export const noiseLayer = (seed: string, label: string, featurePx: number, domain: Domain): Noise2 => {
  const s = seedInt(seed, label);
  const px = domain.periodic ? Math.max(1, Math.round(domain.width / featurePx)) : 0;
  const py = domain.periodic ? Math.max(1, Math.round(domain.height / featurePx)) : 0;
  const fx = domain.periodic ? px / domain.width : 1 / featurePx;
  const fy = domain.periodic ? py / domain.height : 1 / featurePx;
  const wrapX = (i: number): number => (px === 0 ? i : ((i % px) + px) % px);
  const wrapY = (i: number): number => (py === 0 ? i : ((i % py) + py) % py);
  return (x: number, y: number): number => {
    const u = x * fx;
    const v = y * fy;
    const iu = Math.floor(u);
    const iv = Math.floor(v);
    const du = u - iu;
    const dv = v - iv;
    const x0 = wrapX(iu);
    const x1 = wrapX(iu + 1);
    const y0 = wrapY(iv);
    const y1 = wrapY(iv + 1);
    const g00 = hash(x0, y0, s);
    const g10 = hash(x1, y0, s);
    const g01 = hash(x0, y1, s);
    const g11 = hash(x1, y1, s);
    const n00 = GRAD_X[g00]! * du + GRAD_Y[g00]! * dv;
    const n10 = GRAD_X[g10]! * (du - 1) + GRAD_Y[g10]! * dv;
    const n01 = GRAD_X[g01]! * du + GRAD_Y[g01]! * (dv - 1);
    const n11 = GRAD_X[g11]! * (du - 1) + GRAD_Y[g11]! * (dv - 1);
    const a = fade(du);
    const b = fade(dv);
    const nx0 = n00 + a * (n10 - n00);
    const nx1 = n01 + a * (n11 - n01);
    return 1.41 * (nx0 + b * (nx1 - nx0));
  };
};

/** Fractal sum of octaves; result roughly [-1, 1]. */
export const fbm = (
  seed: string,
  label: string,
  featurePx: number,
  octaves: number,
  domain: Domain,
  gain = 0.5,
): Noise2 => {
  const layers = Array.from({ length: octaves }, (_, i) =>
    noiseLayer(seed, `${label}/${i}`, featurePx / 2 ** i, domain),
  );
  const weights = layers.map((_, i) => gain ** i);
  const norm = 1 / weights.reduce((acc, w) => acc + w, 0);
  if (layers.length === 1) return layers[0]!;
  if (layers.length === 2) {
    const [l0, l1] = layers as [Noise2, Noise2];
    const w1 = weights[1]!;
    return (x, y) => (l0(x, y) + w1 * l1(x, y)) * norm;
  }
  return (x, y) => layers.reduce((acc, layer, i) => acc + weights[i]! * layer(x, y), 0) * norm;
};

/** A noise function that always returns zero (used when an effect is disabled). */
export const zeroNoise: Noise2 = () => 0;
