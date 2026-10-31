// Photo-real rendering: albedo + height map in pass 1, normals and lighting in pass 2.

import { createMaskSampler, newMasks } from '../corallite.mts';
import { newSample } from '../fields.mts';
import { fbm, noiseLayer, zeroNoise, type Noise2 } from '../noise.mts';
import { parseHex, toSrgb8, type Rgb } from '../palette.mts';
import type { Finish } from '../options.mts';
import type { RenderContext, Rgba8 } from './context.mts';

/** Material and surface parameters for each finish. */
type FinishParams = {
  readonly eye: number; // eye darkness strength
  readonly septa: number;
  readonly diss: number; // visibility of the dissepiment net
  readonly wall: number;
  readonly eyeSoftness: number;
  readonly radial: number; // strength of the dark-inner → light-outer gradient
  readonly aa: number; // edge softness, in units of the supersample factor
  readonly net: number; // dissepiment line width multiplier
  readonly colorVar: number; // low-frequency warm/cool and light/dark variation
  readonly contrast: number;
  readonly saturation: number;
  readonly chalk: number; // lift toward a dry, pale gray
  readonly wet: number; // "wet look" darkening/saturation of a polish
  readonly grain: number;
  readonly relief: number; // fossil relief standing proud of the surface
  readonly rough: number; // fine surface roughness
  readonly undulation: number; // broad lumps and hollows
  readonly pits: number;
  readonly patches: number; // patternless matrix areas
  readonly stains: number; // greenish/brown weathering stains
  readonly chips: number;
  readonly voids: number; // dark inclusions seen on polished faces
  readonly ambient: number;
  readonly diffuse: number;
  readonly specular: number;
  readonly shininess: number;
  readonly sheen: number; // broad soft reflection
  readonly rim: number; // fresnel-like reflection on the dome edge
  readonly dome: number; // dome height for silhouettes, × max inside distance
};

export const FINISH_PARAMS: { readonly [K in Finish]: FinishParams } = {
  raw: {
    eye: 0.2, septa: 0.85, diss: 0.9, wall: 0.85, eyeSoftness: 0.05, radial: 0.3, aa: 1.4, net: 1.9,
    contrast: 0.8, saturation: 0.9, chalk: 0.12, wet: 0, grain: 0.16, colorVar: 0.14,
    relief: 2, rough: 4, undulation: 1.4, pits: 1.4, patches: 0.5, stains: 1, chips: 0, voids: 0,
    ambient: 0.3, diffuse: 0.95, specular: 0, shininess: 8, sheen: 0, rim: 0, dome: 0.3,
  },
  tumbled: {
    eye: 0.7, septa: 0.75, diss: 0.35, wall: 0.8, eyeSoftness: 0.03, radial: 0.8, aa: 1.2, net: 1.2,
    contrast: 0.92, saturation: 1, chalk: 0.03, wet: 0.2, grain: 0.08, colorVar: 0.1,
    relief: 0.22, rough: 0.25, undulation: 0.35, pits: 0.3, patches: 0.4, stains: 0.15, chips: 0.8, voids: 0.2,
    ambient: 0.42, diffuse: 0.75, specular: 0.08, shininess: 14, sheen: 0.04, rim: 0.05, dome: 0.28,
  },
  polished: {
    eye: 1, septa: 0.85, diss: 0.2, wall: 0.95, eyeSoftness: 0.02, radial: 1, aa: 1, net: 1,
    contrast: 1.1, saturation: 1.25, chalk: 0, wet: 1, grain: 0.06, colorVar: 0.1,
    relief: 0.02, rough: 0.02, undulation: 0.1, pits: 0, patches: 0.12, stains: 0, chips: 0, voids: 1,
    ambient: 0.4, diffuse: 0.75, specular: 0.9, shininess: 120, sheen: 0.06, rim: 0.35, dome: 0.22,
  },
};

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const luminance = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const STAIN: Rgb = parseHex('#6e6b3f');
const VOID: Rgb = parseHex('#2b2118');
const SPEC_COLOR: Rgb = [1, 0.985, 0.96];

export type RealisticRenderer = {
  /** Pass 1: albedo (linear RGB) and height for rows [y0, y1). */
  readonly surfaceRows: (y0: number, y1: number, albedo: Float32Array, height: Float32Array) => void;
  /** Pass 2 (after pass 1 has finished for all rows): lighting into RGBA. */
  readonly shadeRows: (y0: number, y1: number, albedo: Float32Array, height: Float32Array, out: Rgba8) => void;
};

export const createRealistic = (ctx: RenderContext): RealisticRenderer => {
  const { width: W, height: H, palette: P, silhouette, cellSize: d, seed, domain } = ctx;
  const F = FINISH_PARAMS[ctx.finish];
  const masks = createMaskSampler(seed, ctx.traits, d, F.aa * ctx.scale * 0.75, F.eyeSoftness, domain, F.net);
  const warmN = fbm(seed, 'warm', d * 1.6, 2, domain);
  const lightN = fbm(seed, 'lightness', d * 0.9, 2, domain);
  const on = (amount: number, make: () => Noise2): Noise2 => (amount > 0 ? make() : zeroNoise);

  const grain1 = fbm(seed, 'grain1', d * 0.06, 2, domain);
  const grain2 = on(F.grain, () => noiseLayer(seed, 'grain2', Math.max(2, d * 0.012), domain));
  const eyeMottle = noiseLayer(seed, 'eye-mottle', d * 0.08, domain);
  const rough = on(F.rough, () => fbm(seed, 'rough', Math.max(3, d * 0.03), 3, domain));
  const pitN = on(F.pits, () => noiseLayer(seed, 'pits', d * 0.05, domain));
  const patchN = on(F.patches, () => fbm(seed, 'patches', d * 2.6, 3, domain));
  const stainN = on(F.stains, () => fbm(seed, 'stains', d * 0.35, 2, domain));
  const chipN = on(F.chips, () => noiseLayer(seed, 'chips', d * 0.7, domain));
  const voidN = on(F.voids, () => noiseLayer(seed, 'voids', d * 0.09, domain));
  const sheenN = fbm(seed, 'sheen', Math.max(W, H) * 0.5, 2, domain);
  const undN = on(F.undulation, () => fbm(seed, 'undulation', d * 0.7, 3, domain));
  const undAmp = F.undulation * d * 0.02;

  const s = newSample();
  const m = newMasks();

  // Global tone constants
  const mid = luminance(P.body);
  const chalk: Rgb = [P.wall[0] * 0.75, P.wall[1] * 0.75, P.wall[2] * 0.75];
  const wetPow = 1 + 0.35 * F.wet;
  const reliefAmp = F.relief * d * 0.006;
  const roughAmp = F.rough * d * 0.004;
  const pitDepth = d * 0.012;
  const chipDepth = d * 0.02;
  const dome = silhouette ? F.dome * silhouette.maxDist : 0;

  const surfaceRows = (y0: number, y1: number, albedo: Float32Array, height: Float32Array): void => {
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (silhouette && silhouette.alpha[i]! <= 0) continue;
      const px = x + 0.5;
      const py = y + 0.5;
      ctx.fields(px, py, s);
      masks(px, py, s, m);

      const patch = F.patches > 0 ? smoothstep(0.18, 0.5, patchN(px, py)) * F.patches : 0;
      const keep = 1 - patch;
      const septa = m.septa * F.septa * keep;
      const diss = m.diss * F.diss * keep;
      const eye = m.eye * F.eye * keep;
      const wall = m.wall * F.wall * keep;
      const g1 = grain1(px, py);
      const g2 = grain2(px, py);
      const grain = 1 + F.grain * (0.6 * g1 + 0.4 * g2);
      const mottle = 1 + 0.22 * eyeMottle(px, py) * m.eye;
      const pit = F.pits > 0 ? smoothstep(0.5, 0.8, pitN(px, py)) * F.pits : 0;
      const stain = F.stains > 0 ? smoothstep(0.35, 0.7, stainN(px, py)) * F.stains * 0.45 : 0;
      const chip = F.chips > 0 ? smoothstep(0.62, 0.8, chipN(px, py)) * F.chips : 0;
      const voidM = F.voids > 0 ? smoothstep(0.74, 0.86, voidN(px, py)) * F.voids * (1 - m.wall) : 0;

      const warm = F.colorVar * warmN(px, py);
      const bright = 1 + F.colorVar * 0.7 * lightN(px, py);
      const o = i * 3;
      for (let c = 0; c < 3; c++) {
        const base = P.bodyInner[c]! + (P.body[c]! - P.bodyInner[c]!) * (1 - F.radial * (1 - m.radial));
        const v1 = base + (P.septa[c]! - base) * diss * 0.5;
        const v2 = v1 + (P.eye[c]! * mottle - v1) * eye;
        const v3 = v2 + (P.septa[c]! - v2) * septa * 0.8 * (1 - 0.55 * m.eye);
        const v4 =
          (v3 + (P.wall[c]! - v3) * wall) * (1 + 0.1 * m.tint) * bright * (1 + warm * (c === 0 ? 1 : c === 1 ? 0.45 : -0.3));
        const v5 = v4 + (P.matrix[c]! * (1 + 0.12 * g1) - v4) * patch;
        const v6 = v5 + (STAIN[c]! - v5) * stain;
        const v7 = v6 + (P.wall[c]! - v6) * chip * 0.25;
        const v8 = v7 + (VOID[c]! - v7) * voidM;
        albedo[o + c] = v8 * grain * (1 - 0.3 * pit);
      }

      // Tone: saturation, contrast, chalkiness, wet look
      const r = albedo[o]!;
      const g = albedo[o + 1]!;
      const b = albedo[o + 2]!;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const lumC = mid * Math.pow(Math.max(lum, 1e-5) / mid, F.contrast);
      const k = lumC / Math.max(lum, 1e-5);
      for (let c = 0; c < 3; c++) {
        const sat = lum + (albedo[o + c]! - lum) * F.saturation;
        const chalked = sat * k + (chalk[c]! - sat * k) * F.chalk;
        albedo[o + c] = Math.pow(Math.max(0, chalked), wetPow);
      }

      const domeH = silhouette ? dome * (1 - Math.pow(1 - Math.min(1, silhouette.dist[i]! / silhouette.maxDist), 2.5)) : 0;
      height[i] =
        domeH +
        reliefAmp * (m.wall * 1 + m.septa * 0.7 + m.diss * 0.5 - m.eye * 0.4) * keep +
        roughAmp * (rough(px, py) * (1 + patch)) +
        undAmp * undN(px, py) -
        pit * pitDepth -
        chip * chipDepth -
        voidM * d * 0.004;
    }
  }
  };

  // Pass 2: lighting
  const [lx, ly, lz] = ctx.light;
  const hxRaw = lx;
  const hyRaw = ly;
  const hzRaw = lz + 1;
  const hLen = Math.hypot(hxRaw, hyRaw, hzRaw);
  const [hx, hy, hz] = [hxRaw / hLen, hyRaw / hLen, hzRaw / hLen];
  const flat = F.ambient + F.diffuse * lz; // normalizes a flat surface to 1
  const exposure = 1 + 0.12 * F.wet;
  const periodic = domain.periodic;
  const shadeRows = (y0: number, y1: number, albedo: Float32Array, height: Float32Array, out: Rgba8): void => {
  const at = (x: number, y: number): number => {
    const xx = periodic ? (x + W) % W : Math.min(W - 1, Math.max(0, x));
    const yy = periodic ? (y + H) % H : Math.min(H - 1, Math.max(0, y));
    return height[yy * W + xx]!;
  };

  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const alpha = silhouette ? silhouette.alpha[i]! : 1;
      if (alpha <= 0) continue;
      const nxRaw = -(at(x + 1, y) - at(x - 1, y)) / 2;
      const nyRaw = -(at(x, y + 1) - at(x, y - 1)) / 2;
      const nLen = Math.hypot(nxRaw, nyRaw, 1);
      const nx = nxRaw / nLen;
      const ny = nyRaw / nLen;
      const nz = 1 / nLen;
      const diffuse = Math.max(0, nx * lx + ny * ly + nz * lz);
      const ao = silhouette ? 0.6 + 0.4 * smoothstep(0, silhouette.maxDist * 0.06, silhouette.dist[i]!) : 1;
      const shade = ((F.ambient * (0.6 + 0.4 * nz) + F.diffuse * diffuse) / flat) * ao * exposure;
      const nh = Math.max(0, nx * hx + ny * hy + nz * hz);
      const spec = F.specular * Math.pow(nh, F.shininess);
      const sheen = F.sheen * Math.pow(nh, 6) * (0.7 + 0.3 * sheenN(x, y));
      const rim = F.rim * Math.pow(1 - nz, 3) * (silhouette ? smoothstep(0, silhouette.maxDist * 0.02, silhouette.dist[i]!) : 1);
      const gloss = spec + sheen + rim;
      const o = i * 4;
      const a = i * 3;
      out[o] = toSrgb8(albedo[a]! * shade + gloss * SPEC_COLOR[0]);
      out[o + 1] = toSrgb8(albedo[a + 1]! * shade + gloss * SPEC_COLOR[1]);
      out[o + 2] = toSrgb8(albedo[a + 2]! * shade + gloss * SPEC_COLOR[2]);
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  };

  return { surfaceRows, shadeRows };
};
