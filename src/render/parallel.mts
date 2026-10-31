// Distribute row bands across worker threads (or render in-process for 1 thread).

import { Worker } from 'node:worker_threads';
import type { Silhouette } from '../shape.mts';
import { createBandRenderer, phasesFor, type SharedBuffers } from './bands.mts';
import type { RenderOptions, Rgba8 } from './context.mts';

const sharedF32 = (n: number): Float32Array => new Float32Array(new SharedArrayBuffer(n * 4));

const toShared = (a: Float32Array): Float32Array => {
  const s = sharedF32(a.length);
  s.set(a);
  return s;
};

const chunksOf = (height: number, size: number): readonly (readonly [number, number])[] =>
  Array.from({ length: Math.ceil(height / size) }, (_, i) => [i * size, Math.min(height, (i + 1) * size)] as const);

/**
 * Render the stone at internal resolution. Output is identical for any thread
 * count, because every band is computed from the same deterministic context.
 */
export const renderBands = async (
  opts: RenderOptions,
  silhouette: Silhouette | undefined,
  threads: number,
  progress: (fraction: number) => void,
): Promise<Rgba8> => {
  const W = opts.width * opts.supersample;
  const H = opts.height * opts.supersample;
  const parallel = threads > 1;
  const realistic = opts.style === 'realistic';
  const buffers: SharedBuffers = {
    out: new Uint8ClampedArray(parallel ? new SharedArrayBuffer(W * H * 4) : new ArrayBuffer(W * H * 4)),
    albedo: realistic ? (parallel ? sharedF32(W * H * 3) : new Float32Array(W * H * 3)) : undefined,
    height: realistic ? (parallel ? sharedF32(W * H) : new Float32Array(W * H)) : undefined,
    alpha: silhouette ? (parallel ? toShared(silhouette.alpha) : silhouette.alpha) : undefined,
    dist: silhouette ? (parallel ? toShared(silhouette.dist) : silhouette.dist) : undefined,
    maxDist: silhouette?.maxDist ?? 0,
  };
  const phases = phasesFor(opts);
  const chunkRows = Math.max(8, Math.ceil(H / Math.max(1, threads * 12)));
  const chunks = chunksOf(H, chunkRows);
  const total = phases.length * chunks.length;
  const done = { count: 0 };
  const tick = (): void => {
    done.count += 1;
    progress(done.count / total);
  };

  if (!parallel) {
    const render = createBandRenderer(opts, buffers);
    phases.forEach((phase) =>
      chunks.forEach(([y0, y1]) => {
        render(phase, y0, y1);
        tick();
      }),
    );
    return buffers.out;
  }

  const workers = Array.from(
    { length: Math.min(threads, chunks.length) },
    () => new Worker(new URL('./worker.mts', import.meta.url), { workerData: { opts, buffers } }),
  );
  try {
    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            w.once('error', reject);
            w.once('message', () => resolve());
          }),
      ),
    );
    for (const phase of phases) {
      const queue = [...chunks];
      await Promise.all(
        workers.map(
          (w) =>
            new Promise<void>((resolve, reject) => {
              const next = (): void => {
                const job = queue.shift();
                if (!job) {
                  w.off('message', onMessage);
                  w.off('error', reject);
                  resolve();
                  return;
                }
                w.postMessage({ phase, y0: job[0], y1: job[1] });
              };
              const onMessage = (): void => {
                tick();
                next();
              };
              w.on('message', onMessage);
              w.on('error', reject);
              next();
            }),
        ),
      );
    }
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  return buffers.out;
};
