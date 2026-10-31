import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { generate } from '../src/generate.mts';
import { encodeImage } from '../src/encode.mts';
import { FORMATS } from '../src/options.mts';
import { baseOptions, encodeOpts } from './helpers.mts';

const JXL_CODESTREAM = Buffer.from([0xff, 0x0a]);
const JXL_CONTAINER = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20]);

for (const format of FORMATS) {
  for (const shape of ['rect', 'ellipse'] as const) {
    test(`encodes ${format} (${shape}) at the requested size`, async () => {
      const o = { ...baseOptions, shape, width: 120, height: 90 };
      const warnings: string[] = [];
      const bytes = await encodeImage(await generate(o), encodeOpts(o, format), (w) => warnings.push(w));
      if (format === 'jxl') {
        assert.ok(
          bytes.subarray(0, 2).equals(JXL_CODESTREAM) || bytes.subarray(0, 8).equals(JXL_CONTAINER),
          'JPEG XL signature',
        );
        return;
      }
      const meta = await sharp(bytes).metadata();
      assert.equal(meta.format, format === 'jpeg' ? 'jpeg' : format === 'avif' ? 'heif' : format);
      assert.equal(meta.width, 120);
      assert.equal(meta.height, 90);
      const transparent = shape === 'ellipse';
      assert.equal(meta.hasAlpha, transparent && format !== 'jpeg');
      assert.equal(warnings.length, transparent && format === 'jpeg' ? 1 : 0);
    });
  }
}
