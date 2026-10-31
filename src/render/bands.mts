// Row-band rendering shared by the main thread and worker threads.

import type { Silhouette } from '../shape.mts';
import { createRenderContext, type RenderOptions, type Rgba8 } from './context.mts';
import { createStylized } from './stylized.mts';
import { createRealistic } from './realistic.mts';

export type Phase = 'stylized' | 'surface' | 'shade';

/** Buffers shared between threads (backed by SharedArrayBuffer when parallel). */
export type SharedBuffers = {
  readonly out: Rgba8;
  readonly albedo: Float32Array | undefined; // realistic only
  readonly height: Float32Array | undefined; // realistic only
  readonly alpha: Float32Array | undefined; // silhouette only
  readonly dist: Float32Array | undefined; // silhouette only
  readonly maxDist: number;
};

export type BandRenderer = (phase: Phase, y0: number, y1: number) => void;

export const createBandRenderer = (opts: RenderOptions, buffers: SharedBuffers): BandRenderer => {
  const silhouette: Silhouette | undefined =
    buffers.alpha && buffers.dist ? { alpha: buffers.alpha, dist: buffers.dist, maxDist: buffers.maxDist } : undefined;
  const ctx = createRenderContext(opts, silhouette);
  if (opts.style === 'stylized') {
    const rows = createStylized(ctx);
    return (_phase, y0, y1) => rows(y0, y1, buffers.out);
  }
  const renderer = createRealistic(ctx);
  const albedo = buffers.albedo!;
  const height = buffers.height!;
  return (phase, y0, y1) =>
    phase === 'surface'
      ? renderer.surfaceRows(y0, y1, albedo, height)
      : renderer.shadeRows(y0, y1, albedo, height, buffers.out);
};

export const phasesFor = (opts: RenderOptions): readonly Phase[] =>
  opts.style === 'stylized' ? ['stylized'] : ['surface', 'shade'];
