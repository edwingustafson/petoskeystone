// Stone silhouettes: anti-aliased coverage masks drawn with @napi-rs/canvas,
// plus a smoothed inside-distance field used to dome the stone.

import { createCanvas, Path2D } from '@napi-rs/canvas';
import { createRng } from './rng.mts';

export const SHAPES = ['rect', 'ellipse', 'cabochon', 'triangle', 'pebble'] as const;
export type ShapeKind = (typeof SHAPES)[number];

export type Silhouette = {
  readonly alpha: Float32Array; // coverage 0..1
  readonly dist: Float32Array; // smoothed px distance inside the edge (0 outside)
  readonly maxDist: number;
};

type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

const polygonPath = (pts: readonly (readonly [number, number])[]): Path2D => {
  const path = new Path2D();
  pts.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
  path.closePath();
  return path;
};

const ellipsePath = (b: Box): Path2D => {
  const path = new Path2D();
  path.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
  return path;
};

/** Rounded rectangle-ish superellipse |x|^p + |y|^p = 1. */
const cabochonPath = (b: Box): Path2D => {
  const p = 2.8;
  const pts = Array.from({ length: 720 }, (_, i) => {
    const a = (i / 720) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
      b.x + b.w / 2 + (b.w / 2) * Math.sign(c) * Math.abs(c) ** (2 / p),
      b.y + b.h / 2 + (b.h / 2) * Math.sign(s) * Math.abs(s) ** (2 / p),
    ] as const;
  });
  return polygonPath(pts);
};

/** A rounded "guitar pick" triangle, point down, with a gently convex top. */
const trianglePath = (b: Box): Path2D => {
  const corners = [
    [b.x, b.y + b.h * 0.06],
    [b.x + b.w, b.y + b.h * 0.06],
    [b.x + b.w * 0.5, b.y + b.h],
  ] as const;
  const mid = (i: number, j: number): readonly [number, number] => [
    (corners[i]![0] + corners[j]![0]) / 2,
    (corners[i]![1] + corners[j]![1]) / 2,
  ];
  // Each corner is a quadratic control point between edge midpoints; pulling the
  // midpoints outward bulges the edges, as on a real pick.
  const bulge = (m: readonly [number, number], k: number): readonly [number, number] => {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h * 0.42;
    return [m[0] + (m[0] - cx) * k, m[1] + (m[1] - cy) * k];
  };
  const mTop = bulge(mid(0, 1), 0.13);
  const mRight = bulge(mid(1, 2), 0.1);
  const mLeft = bulge(mid(2, 0), 0.1);
  const path = new Path2D();
  path.moveTo(mTop[0], mTop[1]);
  path.quadraticCurveTo(corners[1][0], corners[1][1], mRight[0], mRight[1]);
  path.quadraticCurveTo(corners[2][0], corners[2][1], mLeft[0], mLeft[1]);
  path.quadraticCurveTo(corners[0][0], corners[0][1], mTop[0], mTop[1]);
  path.closePath();
  return path;
};

/** An irregular beach pebble: a smooth closed curve with random low harmonics. */
const pebblePath = (b: Box, seed: string): Path2D => {
  const rng = createRng(seed, 'pebble');
  const harmonics = [2, 3, 4, 5].map((k) => ({ k, amp: rng.uniform(0.02, 0.09) / (k - 1), ph: rng.uniform(0, Math.PI * 2) }));
  const raw = Array.from({ length: 720 }, (_, i) => {
    const a = (i / 720) * Math.PI * 2;
    const r = 1 + harmonics.reduce((acc, h) => acc + h.amp * Math.cos(h.k * a + h.ph), 0);
    return [r * Math.cos(a), r * Math.sin(a)] as const;
  });
  const minX = Math.min(...raw.map((p) => p[0]));
  const maxX = Math.max(...raw.map((p) => p[0]));
  const minY = Math.min(...raw.map((p) => p[1]));
  const maxY = Math.max(...raw.map((p) => p[1]));
  return polygonPath(
    raw.map(([x, y]) => [b.x + ((x - minX) / (maxX - minX)) * b.w, b.y + ((y - minY) / (maxY - minY)) * b.h] as const),
  );
};

/** 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher). */
const edt1d = (f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void => {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    out[q] = dq * dq + f[v[k]!]!;
  }
};

/** Distance (px) from each inside pixel to the nearest outside pixel. */
const distanceInside = (alpha: Float32Array, w: number, h: number): Float32Array => {
  const BIG = 1e20;
  const grid = Float64Array.from(alpha, (a) => (a >= 0.5 ? BIG : 0));
  // (alpha here is the low-resolution coverage)
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]!;
    edt1d(f, h, out, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = out[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]!;
    edt1d(f, w, out, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = out[x]!;
  }
  return Float32Array.from(grid, (d2) => Math.sqrt(d2));
};

/** In-place separable box blur, repeated `passes` times (≈ Gaussian). Edges clamp. */
export const boxBlur = (data: Float32Array, w: number, h: number, radius: number, passes = 3): Float32Array => {
  const r = Math.max(1, Math.round(radius));
  const norm = 1 / (2 * r + 1);
  const n = Math.max(w, h);
  const line = new Float32Array(n);
  const blurred = new Float32Array(n);
  const blurLine = (len: number): void => {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += line[i < 0 ? 0 : i >= len ? len - 1 : i]!;
    for (let i = 0; i < len; i++) {
      blurred[i] = acc * norm;
      const add = i + r + 1;
      const sub = i - r;
      acc += line[add >= len ? len - 1 : add]! - line[sub < 0 ? 0 : sub]!;
    }
  };
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) line[x] = data[o + x]!;
      blurLine(w);
      for (let x = 0; x < w; x++) data[o + x] = blurred[x]!;
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) line[y] = data[y * w + x]!;
      blurLine(h);
      for (let y = 0; y < h; y++) data[y * w + x] = blurred[y]!;
    }
  }
  return data;
};

/** A smooth field stored at reduced resolution (`factor` full-res px per cell). */
export type LowRes = { readonly data: Float32Array; readonly width: number; readonly height: number; readonly factor: number };

/** Bilinear sample of a low-res field at full-res pixel center (x, y). */
export const sampleLowRes = (f: LowRes, x: number, y: number): number => {
  const u = Math.min(f.width - 1, Math.max(0, (x + 0.5) / f.factor - 0.5));
  const v = Math.min(f.height - 1, Math.max(0, (y + 0.5) / f.factor - 0.5));
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = Math.min(f.width - 1, x0 + 1);
  const y1 = Math.min(f.height - 1, y0 + 1);
  const a = u - x0;
  const b = v - y0;
  const d = f.data;
  const top = d[y0 * f.width + x0]! * (1 - a) + d[y0 * f.width + x1]! * a;
  const bottom = d[y1 * f.width + x0]! * (1 - a) + d[y1 * f.width + x1]! * a;
  return top * (1 - b) + bottom * b;
};

/** Box-average a full-res field down by an integer factor. */
const downsample = (src: Float32Array, w: number, h: number, factor: number): LowRes => {
  const lw = Math.ceil(w / factor);
  const lh = Math.ceil(h / factor);
  const sum = new Float32Array(lw * lh);
  const count = new Float32Array(lw * lh);
  for (let y = 0; y < h; y++) {
    const ly = Math.floor(y / factor) * lw;
    for (let x = 0; x < w; x++) {
      const j = ly + Math.floor(x / factor);
      sum[j]! += src[y * w + x]!;
      count[j]! += 1;
    }
  }
  return { data: sum.map((v, j) => v / count[j]!), width: lw, height: lh, factor };
};

/** Resolution at which the smooth distance and shadow fields are computed. */
const FIELD_RES = 768;

export type SilhouetteWithLowRes = Silhouette & { readonly lowAlpha: LowRes };

export const createSilhouette = (kind: Exclude<ShapeKind, 'rect'>, width: number, height: number, seed: string): SilhouetteWithLowRes => {
  const margin = Math.min(width, height) * 0.07;
  const box: Box = { x: margin, y: margin, w: width - 2 * margin, h: height - 2 * margin };
  const path =
    kind === 'ellipse'
      ? ellipsePath(box)
      : kind === 'cabochon'
        ? cabochonPath(box)
        : kind === 'triangle'
          ? trianglePath(box)
          : pebblePath(box, seed);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fill(path);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3]! / 255;

  // The distance field is smooth, so compute it at low resolution and upsample.
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / FIELD_RES));
  const lowAlpha = downsample(alpha, width, height, factor);
  const lowDist = distanceInside(lowAlpha.data, lowAlpha.width, lowAlpha.height).map((d) => d * factor);
  const maxDist = lowDist.reduce((m, d) => (d > m ? d : m), 1);
  // Round off the medial-axis crease so the dome shades smoothly.
  const smooth: LowRes = { data: boxBlur(lowDist, lowAlpha.width, lowAlpha.height, (maxDist * 0.06) / factor), width: lowAlpha.width, height: lowAlpha.height, factor };
  const dist = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      dist[i] = alpha[i]! > 0 ? sampleLowRes(smooth, x, y) : 0;
    }
  }
  return { alpha, dist, maxDist, lowAlpha };
};
