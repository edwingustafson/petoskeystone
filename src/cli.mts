#!/usr/bin/env node
// petoskeystone command-line entry point.

import { writeFile } from 'node:fs/promises';
import { HELP, parseCommandLine, UsageError } from './options.mts';
import { generate } from './generate.mts';
import { encodeImage, jxlBackend } from './encode.mts';

const main = async (): Promise<void> => {
  const opts = await parseCommandLine(process.argv.slice(2));
  if (opts === undefined) {
    process.stdout.write(HELP);
    return;
  }
  const verbose = opts.verbose;
  const lastPct = { value: -1 };
  const log = (msg: string): void => {
    if (!verbose) return;
    const pct = /^render: (\d+)%$/.exec(msg);
    if (pct) {
      // only report every 10%
      const p = Math.floor(Number(pct[1]) / 10) * 10;
      if (p === lastPct.value) return;
      lastPct.value = p;
      process.stderr.write(`  render ${p}%\n`);
      return;
    }
    process.stderr.write(`  ${msg}\n`);
  };
  const t0 = performance.now();
  const rendered = await generate(opts, log);
  const t1 = performance.now();
  const bytes = await encodeImage(rendered, opts, (w) => process.stderr.write(`warning: ${w}\n`));
  await writeFile(opts.output, bytes);
  const t2 = performance.now();
  const look = opts.style === 'stylized' ? `stylized/${opts.palette}` : `realistic/${opts.finish}/${opts.palette}`;
  const encoder = opts.format === 'jxl' ? ` via ${jxlBackend()}` : '';
  process.stdout.write(
    `${opts.output}: ${opts.width}x${opts.height} ${opts.format}${encoder}, ${look}, ${opts.shape}` +
      `${opts.repeat ? ' (tileable)' : ''}, ${rendered.corallites} corallites, seed ${opts.seed}, ` +
      `${(bytes.byteLength / 1024).toFixed(1)} KiB, render ${((t1 - t0) / 1000).toFixed(1)} s + encode ${((t2 - t1) / 1000).toFixed(1)} s\n`,
  );
};

main().catch((e: unknown) => {
  if (e instanceof UsageError) {
    process.stderr.write(`error: ${e.message}\nRun with --help for usage.\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  }
});
