// Corallite centers: a hex lattice, jittered and relaxed, with per-cell weights
// so the result is a power diagram (straight walls, varied cell sizes).

import { createRng } from './rng.mts';
import type { Domain } from './noise.mts';

export type Layout = {
  readonly count: number; // number of distinct corallites
  readonly cellSize: number; // nominal center spacing, px
  /** Positions and weights of all points, including periodic/edge copies. */
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pw: Float64Array;
  readonly pid: Int32Array; // corallite id of each point
  /** Spatial hash over points. */
  readonly bucketSize: number;
  readonly bx0: number;
  readonly by0: number;
  readonly bcols: number;
  readonly brows: number;
  readonly bucketStart: Int32Array; // length bcols*brows+1
  readonly bucketItems: Int32Array;
};

export type LayoutOptions = {
  readonly seed: string;
  readonly cellSize: number;
  readonly regularity: number; // 0..1
  readonly domain: Domain;
};

type Pt = { readonly x: number; readonly y: number };

const SQRT3_2 = Math.sqrt(3) / 2;

const latticePeriodic = (d: number, domain: Domain): readonly Pt[] => {
  const cols = Math.max(1, Math.round(domain.width / d));
  const rows = Math.max(2, 2 * Math.round(domain.height / (d * Math.sqrt(3))));
  const dx = domain.width / cols;
  const dy = domain.height / rows;
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => ({ x: (c + 0.25 + (r % 2) * 0.5) * dx, y: (r + 0.5) * dy })),
  ).flat();
};

const latticeRotated = (d: number, domain: Domain, angle: number, margin: number): readonly Pt[] => {
  const cx = domain.width / 2;
  const cy = domain.height / 2;
  const reach = Math.hypot(domain.width, domain.height) / 2 + margin;
  const n = Math.ceil(reach / (d * SQRT3_2)) + 1;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return Array.from({ length: 2 * n + 1 }, (_, ri) => ri - n)
    .flatMap((r) =>
      Array.from({ length: 2 * n + 1 }, (_, ci) => ci - n).map((c) => {
        const lx = (c + (Math.abs(r) % 2) * 0.5) * d;
        const ly = r * d * SQRT3_2;
        return { x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos };
      }),
    )
    .filter(
      (p) => p.x > -margin && p.x < domain.width + margin && p.y > -margin && p.y < domain.height + margin,
    );
};

/** Add periodic copies (for tiles) and build the spatial hash. */
const buildIndex = (
  base: readonly Pt[],
  weights: readonly number[],
  d: number,
  domain: Domain,
  margin: number,
): Layout => {
  const shifts = domain.periodic
    ? [-1, 0, 1].flatMap((sy) => [-1, 0, 1].map((sx) => ({ sx: sx * domain.width, sy: sy * domain.height })))
    : [{ sx: 0, sy: 0 }];
  const points = shifts.flatMap(({ sx, sy }) =>
    base
      .map((p, id) => ({ x: p.x + sx, y: p.y + sy, w: weights[id]!, id }))
      .filter(
        (p) => p.x > -margin && p.x < domain.width + margin && p.y > -margin && p.y < domain.height + margin,
      ),
  );
  const bucketSize = d;
  const bx0 = -margin;
  const by0 = -margin;
  const bcols = Math.ceil((domain.width + 2 * margin) / bucketSize) + 1;
  const brows = Math.ceil((domain.height + 2 * margin) / bucketSize) + 1;
  const bucketOf = (p: Pt): number =>
    Math.min(brows - 1, Math.max(0, Math.floor((p.y - by0) / bucketSize))) * bcols +
    Math.min(bcols - 1, Math.max(0, Math.floor((p.x - bx0) / bucketSize)));
  const keys = points.map(bucketOf);
  const counts = keys.reduce((acc, k) => {
    acc[k + 1]! += 1;
    return acc;
  }, new Int32Array(bcols * brows + 1));
  const bucketStart = counts.reduce((acc, c, i) => {
    acc[i] = (i > 0 ? acc[i - 1]! : 0) + c;
    return acc;
  }, new Int32Array(counts.length));
  const order = points.map((_, i) => i).sort((a, b) => keys[a]! - keys[b]!);
  return {
    count: base.length,
    cellSize: d,
    px: Float64Array.from(points, (p) => p.x),
    py: Float64Array.from(points, (p) => p.y),
    pw: Float64Array.from(points, (p) => p.w),
    pid: Int32Array.from(points, (p) => p.id),
    bucketSize,
    bx0,
    by0,
    bcols,
    brows,
    bucketStart,
    bucketItems: Int32Array.from(order),
  };
};

/**
 * Index of the point with the smallest power distance |p-s|² - w, searching
 * a (2r+1)² neighbourhood of buckets. Returns -1 if none found.
 */
export const nearestPoint = (layout: Layout, x: number, y: number, radius = 2): number => {
  const { bucketSize, bx0, by0, bcols, brows, bucketStart, bucketItems, px, py, pw } = layout;
  const bc = Math.floor((x - bx0) / bucketSize);
  const br = Math.floor((y - by0) / bucketSize);
  let best = -1;
  let bestD = Infinity;
  for (let r = Math.max(0, br - radius); r <= Math.min(brows - 1, br + radius); r++) {
    for (let c = Math.max(0, bc - radius); c <= Math.min(bcols - 1, bc + radius); c++) {
      const b = r * bcols + c;
      for (let k = bucketStart[b]!; k < bucketStart[b + 1]!; k++) {
        const i = bucketItems[k]!;
        const dx = x - px[i]!;
        const dy = y - py[i]!;
        const dd = dx * dx + dy * dy - pw[i]!;
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      }
    }
  }
  return best;
};

/** Lloyd relaxation step on a coarse sample grid (toroidal when periodic). */
const relax = (base: readonly Pt[], weights: readonly number[], d: number, domain: Domain, margin: number): readonly Pt[] => {
  const index = buildIndex(base, weights, d, domain, margin);
  const step = d / 7;
  const x0 = domain.periodic ? 0 : -margin;
  const y0 = domain.periodic ? 0 : -margin;
  const x1 = domain.periodic ? domain.width : domain.width + margin;
  const y1 = domain.periodic ? domain.height : domain.height + margin;
  const sumX = new Float64Array(base.length);
  const sumY = new Float64Array(base.length);
  const n = new Float64Array(base.length);
  for (let y = y0 + step / 2; y < y1; y += step) {
    for (let x = x0 + step / 2; x < x1; x += step) {
      const i = nearestPoint(index, x, y);
      if (i < 0) continue;
      const id = index.pid[i]!;
      // accumulate the offset from the (possibly shifted) copy so wrap-around works
      sumX[id]! += x - index.px[i]!;
      sumY[id]! += y - index.py[i]!;
      n[id]! += 1;
    }
  }
  return base.map((p, id) => {
    const moved = n[id]! > 0 ? { x: p.x + sumX[id]! / n[id]!, y: p.y + sumY[id]! / n[id]! } : p;
    return domain.periodic
      ? { x: ((moved.x % domain.width) + domain.width) % domain.width, y: ((moved.y % domain.height) + domain.height) % domain.height }
      : moved;
  });
};

export const createLayout = (opts: LayoutOptions): Layout => {
  const { seed, cellSize: d, domain } = opts;
  const reg = Math.min(1, Math.max(0, opts.regularity));
  const rng = createRng(seed, 'layout');
  const margin = 3 * d;
  const lattice = domain.periodic ? latticePeriodic(d, domain) : latticeRotated(d, domain, rng.uniform(0, Math.PI / 3), margin);
  const jitter = (1 - reg) * d * 0.75;
  const jittered = lattice.map((p) => {
    const a = rng.uniform(0, 2 * Math.PI);
    const r = jitter * Math.sqrt(rng.next());
    return { x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) };
  });
  // Size variation: power-diagram weights, larger spread at lower regularity.
  // Weights are capped so every seed stays inside its own cell (else eyes land on walls).
  const sigma = 0.035 * (1 - reg);
  const cap = 0.06;
  const weights = jittered.map(() => Math.max(-cap, Math.min(cap, rng.normal(0, sigma))) * d * d);
  // At least one relaxation step whenever jittered: removes slivers but stays irregular.
  const iterations = reg >= 1 ? 0 : 1 + Math.round(reg * 2);
  const relaxed = Array.from({ length: iterations }).reduce<readonly Pt[]>(
    (pts) => relax(pts, weights, d, domain, margin),
    jittered,
  );
  return buildIndex(relaxed, weights, d, domain, margin);
};
