// Per-corallite traits and the anatomical masks: wall, septa, dissepiments, eye.

import type { CellSample } from './fields.mts';
import { createRng } from './rng.mts';
import { noiseLayer, type Domain } from './noise.mts';

export type Traits = {
  readonly eyeR: Float32Array; // eye radius in normalized-radius units
  readonly septa: Int32Array; // number of major septa
  readonly phase: Float32Array; // septa rotation, in cycles
  readonly tint: Float32Array; // lightness jitter, about ±1
};

export const createTraits = (seed: string, count: number, regularity: number): Traits => {
  const rng = createRng(seed, 'traits');
  const spread = 0.35 + 0.65 * (1 - regularity);
  const eyeR = new Float32Array(count);
  const septa = new Int32Array(count);
  const phase = new Float32Array(count);
  const tint = new Float32Array(count);
  Array.from({ length: count }).forEach((_, i) => {
    eyeR[i] = Math.min(0.5, Math.max(0.22, rng.normal(0.37, 0.045 * spread)));
    septa[i] = Math.max(12, Math.round(rng.normal(22, 2.5 * spread)));
    phase[i] = rng.next();
    tint[i] = Math.max(-1, Math.min(1, rng.normal(0, 0.45)));
  });
  return { eyeR, septa, phase, tint };
};

export type Masks = {
  wall: number;
  septa: number;
  diss: number; // dissepiments: the fine concentric net between septa
  eye: number;
  radial: number; // 0 at the eye edge … 1 at the wall
  tint: number;
};

export const newMasks = (): Masks => ({ wall: 0, septa: 0, diss: 0, eye: 0, radial: 0, tint: 0 });

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Deterministic 0..1 value for septum `j` of corallite `id`. */
const septumHash = (id: number, j: number): number => {
  const h0 = Math.imul(id + 1, 2654435761) ^ Math.imul(j + 7, 2246822519);
  const h1 = Math.imul(h0 ^ (h0 >>> 15), 3266489917);
  return ((h1 ^ (h1 >>> 13)) >>> 0) / 4294967296;
};

export type MaskSampler =(x: number, y: number, s: CellSample, out: Masks) => void;

/**
 * `aa` is the edge softness in px; `eyeSoftness` widens the eye edge
 * (realistic finishes use softer, noisier eyes).
 */
export const createMaskSampler = (
  seed: string,
  traits: Traits,
  cellSize: number,
  aa: number,
  eyeSoftness: number,
  domain: Domain,
  netWidth = 1,
): MaskSampler => {
  const d = cellSize;
  const wallHalf = Math.max(0.6, d * 0.012);
  const septaHalf = Math.max(0.5, d * 0.0052);
  const minorHalf = septaHalf * 0.7;
  const dissHalf = Math.max(0.4, d * 0.0045 * netWidth);
  const dissSpacing = d * 0.042;
  const eyeNoise = noiseLayer(seed, 'eye-edge', d * 0.16, domain);
  const septaWiggle = noiseLayer(seed, 'septa-wiggle', d * 0.22, domain);
  const dissNoise = noiseLayer(seed, 'diss', d * 0.12, domain);
  const TAU = Math.PI * 2;

  return (x, y, s, out) => {
    const id = s.id;
    const eyeR = traits.eyeR[id]!;
    const n = traits.septa[id]!;
    const t = s.t;
    const cellR = s.r + s.wallDist;

    // Eye (calyx)
    const soft = 0.012 + eyeSoftness + aa / Math.max(cellR, 1);
    const te = t + 0.055 * eyeNoise(x, y);
    out.eye = 1 - smoothstep(eyeR - soft, eyeR + soft, te);

    // Septa: major ridges plus shorter minor ridges between them. They reach
    // partway into the eye (a star-shaped eye edge) and thicken toward the
    // wall, where they merge into it with a zigzag.
    const inner = smoothstep(eyeR * 0.45, eyeR + 0.05, t);
    const a = (s.theta / TAU) * n + traits.phase[id]! + 0.07 * septaWiggle(x, y);
    const fl = Math.floor(a);
    const f = a - fl;
    const nearest = f < 0.5 ? fl : fl + 1;
    const vary = septumHash(id, ((nearest % n) + n) % n); // 0..1, per septum
    const widen = 0.55 + 1.1 * t * t;
    const arc = (TAU / n) * s.r;
    const distMajor = Math.min(f, 1 - f) * arc;
    const distMinor = Math.abs(f - 0.5) * arc;
    const hw = septaHalf * widen * (0.7 + 0.6 * vary);
    const major = (1 - smoothstep(hw - aa, hw + aa, distMajor)) * (0.75 + 0.25 * vary);
    const mw = minorHalf * widen;
    const minor = (1 - smoothstep(mw - aa, mw + aa, distMinor)) * smoothstep(0.52, 0.68, t) * 0.85;
    const septa = Math.max(major, minor) * inner;
    out.septa = septa * (0.45 + 0.55 * smoothstep(eyeR, 1, t));

    // Wall, notched where septa meet it
    const wHalf = wallHalf * (1 + 0.9 * Math.max(major, minor * 0.6));
    out.wall = 1 - smoothstep(wHalf - aa, wHalf + aa, s.wallDist);

    // Dissepiments: concentric arcs bridging the septa
    const u = s.r / dissSpacing + 0.6 * dissNoise(x, y);
    const g = Math.abs(u - Math.round(u)) * dissSpacing;
    out.diss = (1 - smoothstep(dissHalf - aa, dissHalf + aa, g)) * inner * (1 - septa);

    out.radial = smoothstep(eyeR, 1, t);
    out.tint = traits.tint[id]!;
  };
};
