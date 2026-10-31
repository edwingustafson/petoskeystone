// Flat, crisp, graphic rendering of the corallite anatomy.

import { createMaskSampler, newMasks } from '../corallite.mts';
import { newSample } from '../fields.mts';
import { toSrgb8 } from '../palette.mts';
import type { RenderContext, Rgba8 } from './context.mts';

/** Returns a function that renders rows [y0, y1) into `out`. */
export const createStylized = (ctx: RenderContext): ((y0: number, y1: number, out: Rgba8) => void) => {
  const { width, palette: P, silhouette } = ctx;
  const masks = createMaskSampler(ctx.seed, ctx.traits, ctx.cellSize, 0.75, 0, ctx.domain);
  const s = newSample();
  const m = newMasks();
  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

  return (y0, y1, out) => {
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const alpha = silhouette ? silhouette.alpha[i]! : 1;
      if (alpha <= 0) continue;
      const px = x + 0.5;
      const py = y + 0.5;
      ctx.fields(px, py, s);
      masks(px, py, s, m);
      const shade = 1 + 0.05 * m.tint;
      const septa = m.septa * (1 - 0.55 * m.eye);
      const o = i * 4;
      for (let c = 0; c < 3; c++) {
        const base = mix(P.bodyInner[c]!, P.body[c]!, m.radial);
        const withDiss = mix(base, P.septa[c]!, m.diss * 0.15);
        const withEye = mix(withDiss, P.eye[c]!, m.eye);
        const withSepta = mix(withEye, P.septa[c]!, septa * 0.85);
        out[o + c] = toSrgb8(mix(withSepta * shade, P.wall[c]!, m.wall));
      }
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  };
};
