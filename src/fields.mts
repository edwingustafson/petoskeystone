// Per-pixel geometry of the colony: which corallite a point is in, its distance
// to the nearest wall, and polar coordinates relative to the corallite center.

import { nearestPoint, type Layout } from './layout.mts';
import { fbm, type Domain } from './noise.mts';

/** Mutable output record, reused across pixels to avoid allocation. */
export type CellSample = {
  id: number; // corallite id
  wallDist: number; // px to the nearest wall (power-diagram bisector)
  r: number; // px from the corallite center
  t: number; // normalized radius: 0 at center, 1 at the wall
  theta: number; // polar angle around the center
};

export const newSample = (): CellSample => ({ id: -1, wallDist: 0, r: 0, t: 0, theta: 0 });

export type FieldSampler = (x: number, y: number, out: CellSample) => void;

/**
 * For each small bucket, the points that can be the nearest seed, or own the
 * nearest wall, for any query point inside it. Candidate data is copied into
 * contiguous arrays so the per-pixel loop is a single linear scan.
 */
type Candidates = {
  readonly size: number;
  readonly x0: number;
  readonly y0: number;
  readonly cols: number;
  readonly rows: number;
  readonly start: Int32Array;
  readonly cx: Float64Array;
  readonly cy: Float64Array;
  readonly cw: Float64Array;
  readonly cid: Int32Array;
};

/** Indices of all layout points within `radius` of (x, y), via the coarse grid. */
const pointsNear = (layout: Layout, x: number, y: number, radius: number): number[] => {
  const { bucketSize, bx0, by0, bcols, brows, bucketStart, bucketItems, px, py } = layout;
  const c0 = Math.max(0, Math.floor((x - radius - bx0) / bucketSize));
  const c1 = Math.min(bcols - 1, Math.floor((x + radius - bx0) / bucketSize));
  const r0 = Math.max(0, Math.floor((y - radius - by0) / bucketSize));
  const r1 = Math.min(brows - 1, Math.floor((y + radius - by0) / bucketSize));
  const found: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const b = r * bcols + c;
      for (let k = bucketStart[b]!; k < bucketStart[b + 1]!; k++) {
        const i = bucketItems[k]!;
        if (Math.hypot(px[i]! - x, py[i]! - y) <= radius) found.push(i);
      }
    }
  }
  return found;
};

const buildCandidates = (layout: Layout, domain: Domain, reach: number): Candidates => {
  const d = layout.cellSize;
  const x0 = -reach;
  const y0 = -reach;
  const x1 = domain.width + reach;
  const y1 = domain.height + reach;
  // Largest distance from any query point to its (power-)nearest seed.
  const step = d / 8;
  const rmax = { value: 0 };
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const i = nearestPoint(layout, x, y, 3);
      const r = Math.hypot(x - layout.px[i]!, y - layout.py[i]!);
      if (r > rmax.value) rmax.value = r;
    }
  }
  const wMax = layout.pw.reduce((m, w) => Math.max(m, w), -Infinity);
  const wMin = layout.pw.reduce((m, w) => Math.min(m, w), Infinity);
  const wSlack = Math.sqrt(Math.max(0, wMax - wMin));
  const size = d / 2;
  const half = (size * Math.SQRT2) / 2;
  const radius = 2 * (rmax.value + step) + half + wSlack;
  const cols = Math.ceil((x1 - x0) / size) + 1;
  const rows = Math.ceil((y1 - y0) / size) + 1;
  const lists = Array.from({ length: cols * rows }, (_, b) => {
    const bx = x0 + ((b % cols) + 0.5) * size;
    const by = y0 + (Math.floor(b / cols) + 0.5) * size;
    return pointsNear(layout, bx, by, radius);
  });
  const flat = lists.flat();
  const start = lists.reduce((acc, list, b) => {
    acc[b + 1] = acc[b]! + list.length;
    return acc;
  }, new Int32Array(cols * rows + 1));
  return {
    size,
    x0,
    y0,
    cols,
    rows,
    start,
    cx: Float64Array.from(flat, (i) => layout.px[i]!),
    cy: Float64Array.from(flat, (i) => layout.py[i]!),
    cw: Float64Array.from(flat, (i) => layout.pw[i]!),
    cid: Int32Array.from(flat, (i) => layout.pid[i]!),
  };
};

export const createFieldSampler = (
  layout: Layout,
  seed: string,
  wobble: number,
  domain: Domain,
): FieldSampler => {
  const d = layout.cellSize;
  const amp = Math.max(0, wobble) * d * 0.16;
  const warpX = fbm(seed, 'warp-x', d * 1.1, 2, domain);
  const warpY = fbm(seed, 'warp-y', d * 1.1, 2, domain);
  const cand = buildCandidates(layout, domain, amp * 1.5 + 2);
  const { size, x0: gx0, y0: gy0, cols, rows, start, cx, cy, cw, cid } = cand;

  return (x0, y0, out) => {
    const x = amp > 0 ? x0 + amp * warpX(x0, y0) : x0;
    const y = amp > 0 ? y0 + amp * warpY(x0, y0) : y0;
    const bc = Math.min(cols - 1, Math.max(0, Math.floor((x - gx0) / size)));
    const br = Math.min(rows - 1, Math.max(0, Math.floor((y - gy0) / size)));
    const b = br * cols + bc;
    const k0 = start[b]!;
    const k1 = start[b + 1]!;

    let best = k0;
    let bestD = Infinity;
    for (let k = k0; k < k1; k++) {
      const dx = x - cx[k]!;
      const dy = y - cy[k]!;
      const dd = dx * dx + dy * dy - cw[k]!;
      if (dd < bestD) {
        bestD = dd;
        best = k;
      }
    }

    const sx = cx[best]!;
    const sy = cy[best]!;
    let wall = Infinity;
    for (let k = k0; k < k1; k++) {
      if (k === best) continue;
      const ex = cx[k]! - sx;
      const ey = cy[k]! - sy;
      const sep2 = ex * ex + ey * ey;
      if (sep2 < 1e-12) continue;
      const dx = x - cx[k]!;
      const dy = y - cy[k]!;
      const dist = (dx * dx + dy * dy - cw[k]! - bestD) / (2 * Math.sqrt(sep2));
      if (dist < wall) wall = dist;
    }

    const ddx = x - sx;
    const ddy = y - sy;
    const rad = Math.sqrt(ddx * ddx + ddy * ddy);
    const w = Math.max(0, wall);
    out.id = cid[best]!;
    out.wallDist = w;
    out.r = rad;
    out.t = rad + w > 0 ? rad / (rad + w) : 0;
    out.theta = Math.atan2(ddy, ddx);
  };
};
