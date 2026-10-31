import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/generate.mts';
import { createLayout } from '../src/layout.mts';
import { createFieldSampler, newSample } from '../src/fields.mts';
import { baseOptions, renderRaw } from './helpers.mts';

const bytesOf = (a: Uint8ClampedArray): Buffer => Buffer.from(Uint8Array.from(a));

test('same seed gives identical pixels; different seed differs', async () => {
  const a = (await generate({ ...baseOptions, threads: 1 })).data;
  const b = (await generate({ ...baseOptions, threads: 1 })).data;
  const c = (await generate({ ...baseOptions, seed: 'other', threads: 1 })).data;
  assert.ok(bytesOf(a).equals(bytesOf(b)));
  assert.ok(!bytesOf(a).equals(bytesOf(c)));
});

for (const [style, shape] of [['stylized', 'rect'], ['realistic', 'pebble']] as const) {
  test(`output is identical for 1 and 4 threads (${style}, ${shape})`, async () => {
    const o = { ...baseOptions, style, shape, supersample: 2 };
    const one = (await generate({ ...o, threads: 1 })).data;
    const four = (await generate({ ...o, threads: 4 })).data;
    assert.ok(bytesOf(one).equals(bytesOf(four)));
  });
}

/** Mean absolute RGB difference between columns x0 and x1 (or rows when `rows`). */
const lineDiff = (img: { data: Buffer; width: number; height: number; channels: number }, a: number, b: number, rows: boolean): number => {
  const n = rows ? img.width : img.height;
  const total = Array.from({ length: n }, (_, k) => {
    const ia = rows ? (a * img.width + k) * img.channels : (k * img.width + a) * img.channels;
    const ib = rows ? (b * img.width + k) * img.channels : (k * img.width + b) * img.channels;
    return [0, 1, 2].reduce((acc, c) => acc + Math.abs(img.data[ia + c]! - img.data[ib + c]!), 0) / 3;
  }).reduce((acc, v) => acc + v, 0);
  return total / n;
};

const assertSeamless = (img: { data: Buffer; width: number; height: number; channels: number }, label: string): void => {
  const interiorX = Array.from({ length: img.width - 1 }, (_, x) => lineDiff(img, x, x + 1, false));
  const interiorY = Array.from({ length: img.height - 1 }, (_, y) => lineDiff(img, y, y + 1, true));
  const meanX = interiorX.reduce((a, v) => a + v, 0) / interiorX.length;
  const meanY = interiorY.reduce((a, v) => a + v, 0) / interiorY.length;
  const seamX = lineDiff(img, img.width - 1, 0, false);
  const seamY = lineDiff(img, img.height - 1, 0, true);
  assert.ok(seamX < meanX * 1.6 + 1, `${label}: horizontal seam ${seamX.toFixed(2)} vs interior ${meanX.toFixed(2)}`);
  assert.ok(seamY < meanY * 1.6 + 1, `${label}: vertical seam ${seamY.toFixed(2)} vs interior ${meanY.toFixed(2)}`);
};

for (const [style, finish] of [['stylized', 'polished'], ['realistic', 'raw'], ['realistic', 'polished']] as const) {
  test(`--repeat tiles seamlessly (${style}/${finish}, supersampled)`, async () => {
    const img = await renderRaw({ ...baseOptions, style, finish, repeat: true, supersample: 2, width: 200, height: 150 });
    assertSeamless(img, `${style}/${finish}`);
  });
}

test('a non-repeating render has a clearly visible seam (sanity check of the seam metric)', async () => {
  const img = await renderRaw({ ...baseOptions, style: 'stylized', repeat: false, width: 200, height: 150 });
  const interior = Array.from({ length: img.width - 1 }, (_, x) => lineDiff(img, x, x + 1, false));
  const mean = interior.reduce((a, v) => a + v, 0) / interior.length;
  assert.ok(lineDiff(img, img.width - 1, 0, false) > mean * 1.6 + 1);
});

test('regularity 1 with no wobble gives equal hexagons with six neighbours', () => {
  const domain = { width: 480, height: 416, periodic: true };
  const layout = createLayout({ seed: 's', cellSize: 40, regularity: 1, domain });
  const fields = createFieldSampler(layout, 's', 0, domain);
  const s = newSample();
  const ids = new Int32Array(domain.width * domain.height);
  for (let y = 0; y < domain.height; y++) {
    for (let x = 0; x < domain.width; x++) {
      fields(x + 0.5, y + 0.5, s);
      ids[y * domain.width + x] = s.id;
    }
  }
  const areas = ids.reduce((acc, id) => {
    acc[id]! += 1;
    return acc;
  }, new Int32Array(layout.count));
  const mean = areas.reduce((a, v) => a + v, 0) / areas.length;
  areas.forEach((a, id) => assert.ok(Math.abs(a - mean) / mean < 0.04, `cell ${id} area ${a} vs mean ${mean}`));

  const neighbours = Array.from({ length: layout.count }, () => new Set<number>());
  for (let y = 0; y < domain.height; y++) {
    for (let x = 0; x < domain.width; x++) {
      const id = ids[y * domain.width + x]!;
      const right = ids[y * domain.width + ((x + 1) % domain.width)]!;
      const down = ids[((y + 1) % domain.height) * domain.width + x]!;
      [right, down].filter((n) => n !== id).forEach((n) => {
        neighbours[id]!.add(n);
        neighbours[n]!.add(id);
      });
    }
  }
  neighbours.forEach((set, id) => assert.equal(set.size, 6, `cell ${id} has ${set.size} neighbours`));
});

test('silhouettes are transparent outside the stone and opaque inside', async () => {
  const r = await generate({ ...baseOptions, shape: 'ellipse', shadow: false });
  assert.equal(r.hasAlpha, true);
  const alphaAt = (x: number, y: number): number => r.data[(y * r.width + x) * 4 + 3]!;
  assert.equal(alphaAt(0, 0), 0);
  assert.equal(alphaAt(Math.floor(r.width / 2), Math.floor(r.height / 2)), 255);
});

test('a silhouette over a solid background is fully opaque', async () => {
  const r = await generate({ ...baseOptions, shape: 'pebble', background: '#336699' });
  assert.equal(r.hasAlpha, false);
  assert.ok(Array.from({ length: r.width * r.height }, (_, i) => r.data[i * 4 + 3]!).every((a) => a === 255));
});
