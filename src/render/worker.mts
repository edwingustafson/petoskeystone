// Worker thread: builds its own render context and renders row bands on request.

import { parentPort, workerData } from 'node:worker_threads';
import { createBandRenderer, type Phase, type SharedBuffers } from './bands.mts';
import type { RenderOptions } from './context.mts';

type Init = { readonly opts: RenderOptions; readonly buffers: SharedBuffers };
type Job = { readonly phase: Phase; readonly y0: number; readonly y1: number };

const { opts, buffers } = workerData as Init;
const render = createBandRenderer(opts, buffers);
const port = parentPort!;
port.on('message', (job: Job) => {
  render(job.phase, job.y0, job.y1);
  port.postMessage({ y0: job.y0, y1: job.y1 });
});
port.postMessage('ready');
