// Render a gallery of looks into examples/ plus a contact sheet.

import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { generate, type GenerateOptions } from '../src/generate.mts';
import { encodeImage } from '../src/encode.mts';

const SIZE = 768;
const base: GenerateOptions = {
  style: 'realistic', finish: 'polished', palette: 'natural', colors: [],
  width: SIZE, height: SIZE, shape: 'rect', background: 'transparent', shadow: true,
  repeat: false, cellSize: 110, regularity: 0.6, wobble: 0.3,
  lightAzimuth: 135, lightElevation: 45, seed: 'petoskey', supersample: 2,
};

const examples: readonly (readonly [string, Partial<GenerateOptions>])[] = [
  ['stylized-natural', { style: 'stylized' }],
  ['stylized-ocean-tile', { style: 'stylized', palette: 'ocean', repeat: true }],
  ['stylized-ember-regular', { style: 'stylized', palette: 'ember', regularity: 1, wobble: 0 }],
  ['stylized-neon-chaotic', { style: 'stylized', palette: 'neon', regularity: 0, wobble: 0.8 }],
  ['raw-pebble', { finish: 'raw', shape: 'pebble', background: '#3a2a20' }],
  ['tumbled-ellipse', { finish: 'tumbled', shape: 'ellipse', background: '#5d7f3c' }],
  ['polished-triangle', { finish: 'polished', shape: 'triangle', background: '#c9c9c9', cellSize: 80 }],
  ['polished-tile', { finish: 'polished', repeat: true }],
];

await mkdir('examples', { recursive: true });
const files = await Promise.all(
  examples.map(async ([name, overrides]) => {
    const o = { ...base, ...overrides };
    const img = await generate(o);
    const bytes = await encodeImage(img, { format: 'jpeg', width: o.width, height: o.height, background: '#ffffff', quality: 88, effort: undefined, lossless: false }, () => {});
    const file = `examples/${name}.jpg`;
    await writeFile(file, bytes);
    process.stdout.write(`${file}\n`);
    return file;
  }),
);

const thumb = SIZE / 2;
const cols = 4;
const tiles = await Promise.all(files.map((f) => sharp(f).resize(thumb, thumb).toBuffer()));
await sharp({ create: { width: cols * thumb, height: Math.ceil(files.length / cols) * thumb, channels: 3, background: '#ffffff' } })
  .composite(tiles.map((input, i) => ({ input, left: (i % cols) * thumb, top: Math.floor(i / cols) * thumb })))
  .jpeg({ quality: 85 })
  .toFile('examples/contact-sheet.jpg');
process.stdout.write('examples/contact-sheet.jpg\n');
