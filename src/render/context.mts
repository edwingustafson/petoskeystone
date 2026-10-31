// Everything a renderer needs, at internal (supersampled) resolution. Built
// deterministically from options, so every worker thread builds the same one.

import type { Domain } from '../noise.mts';
import { getPalette, type Palette } from '../palette.mts';
import { createFieldSampler, type FieldSampler } from '../fields.mts';
import { createTraits, type Traits } from '../corallite.mts';
import { createLayout } from '../layout.mts';
import type { Silhouette } from '../shape.mts';
import type { Finish, Options } from '../options.mts';

export type RenderOptions = Pick<
  Options,
  | 'style' | 'finish' | 'palette' | 'colors' | 'width' | 'height' | 'shape' | 'background' | 'shadow'
  | 'repeat' | 'cellSize' | 'regularity' | 'wobble' | 'lightAzimuth' | 'lightElevation' | 'seed' | 'supersample'
>;

export type RenderContext = {
  readonly seed: string;
  readonly width: number;
  readonly height: number;
  readonly domain: Domain;
  readonly cellSize: number; // internal px
  readonly scale: number; // supersample factor
  readonly palette: Palette;
  readonly fields: FieldSampler;
  readonly traits: Traits;
  readonly corallites: number;
  readonly silhouette: Silhouette | undefined;
  readonly finish: Finish;
  readonly light: readonly [number, number, number]; // unit vector toward the light, y down
};

/** RGBA, straight alpha, 8-bit sRGB. */
export type Rgba8 = Uint8ClampedArray;

export const lightVector = (azimuthDeg: number, elevationDeg: number): readonly [number, number, number] => {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  // azimuth: 0 = from the right, 90 = from the top (image y points down)
  return [Math.cos(az) * Math.cos(el), -Math.sin(az) * Math.cos(el), Math.sin(el)];
};

export const createRenderContext = (opts: RenderOptions, silhouette: Silhouette | undefined): RenderContext => {
  const scale = opts.supersample;
  const width = opts.width * scale;
  const height = opts.height * scale;
  const domain: Domain = { width, height, periodic: opts.repeat };
  const cellSize = opts.cellSize * scale;
  const layout = createLayout({ seed: opts.seed, cellSize, regularity: opts.regularity, domain });
  return {
    seed: opts.seed,
    width,
    height,
    domain,
    cellSize,
    scale,
    palette: getPalette(opts.palette, opts.colors),
    fields: createFieldSampler(layout, opts.seed, opts.wobble, domain),
    traits: createTraits(opts.seed, layout.count, opts.regularity),
    corallites: layout.count,
    silhouette,
    finish: opts.finish,
    light: lightVector(opts.lightAzimuth, opts.lightElevation),
  };
};
