// Option types, defaults, parsing, config-file merging and validation.

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseArgs } from 'node:util';
import { randomInt } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { isHexColor, PALETTE_NAMES } from './palette.mts';
import { SHAPES, type ShapeKind } from './shape.mts';

export const FORMATS = ['png', 'jpeg', 'jxl', 'avif'] as const;
export type Format = (typeof FORMATS)[number];
export const STYLES = ['stylized', 'realistic'] as const;
export type Style = (typeof STYLES)[number];
export const FINISHES = ['raw', 'tumbled', 'polished'] as const;
export type Finish = (typeof FINISHES)[number];

export type Options = {
  readonly output: string;
  readonly format: Format;
  readonly style: Style;
  readonly finish: Finish;
  readonly palette: string;
  readonly colors: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly shape: ShapeKind;
  readonly background: string; // 'transparent' or a hex color
  readonly shadow: boolean;
  readonly repeat: boolean;
  readonly cellSize: number;
  readonly regularity: number;
  readonly wobble: number;
  readonly lightAzimuth: number;
  readonly lightElevation: number;
  readonly seed: string;
  readonly supersample: number;
  readonly threads: number;
  readonly quality: number | undefined;
  readonly effort: number | undefined;
  readonly lossless: boolean;
  readonly verbose: boolean;
};

export class UsageError extends Error {}

export const HELP = `petoskeystone: procedurally generate Petoskey stone (Hexagonaria) images

Usage: petoskeystone [options] -o <file.png|.jpg|.jxl|.avif>

Look
  --style <s>          stylized | realistic                         [realistic]
  --finish <f>         raw | tumbled | polished (realistic only)    [polished]
  --palette <p>        ${PALETTE_NAMES.join(' | ')}  [natural]
  --colors <list>      for --palette custom: wall,body,eye[,septa,matrix] hex colors

Pattern
  --cell-size <px>     mean corallite diameter in output pixels     [160]
  --regularity <0..1>  0 = chaotic, 1 = perfect hexagons            [0.6]
  --wobble <0..1+>     waviness of the corallite walls              [0.3]
  --repeat             seamless repeating tile (rect shape only)
  --seed <s>           reproducible randomness                      [random]

Output
  -o, --output <file>  output file; format from extension
  --format <f>         png | jpeg | jxl | avif (overrides extension)
  --size <WxH>         output pixel size                            [2048x2048]
  --width/--height <n> output pixel width/height
  --shape <s>          ${SHAPES.join(' | ')}             [rect]
  --background <c>     transparent | #rrggbb                        [transparent]
  --no-shadow          no drop shadow under silhouettes
  --light <az,el>      light azimuth,elevation in degrees           [135,45]
  --supersample <1-4>  anti-aliasing factor                         [2]
  --threads <n>        worker threads (1 = no workers)              [CPU count]
  --quality <0-100>    lossy quality (jpeg 90, avif 60, jxl 85)
  --effort <n>         encoder effort (png 0-9, avif 0-9, jxl 1-9)
  --lossless           lossless avif/jxl

Other
  --config <file>      JSON file of options (same names as flags); flags override
  -v, --verbose        progress details
  -h, --help           this help
`;

const ARG_SPEC = {
  output: { type: 'string', short: 'o' },
  format: { type: 'string' },
  style: { type: 'string' },
  finish: { type: 'string' },
  palette: { type: 'string' },
  colors: { type: 'string' },
  size: { type: 'string' },
  width: { type: 'string' },
  height: { type: 'string' },
  shape: { type: 'string' },
  background: { type: 'string' },
  shadow: { type: 'boolean' },
  'no-shadow': { type: 'boolean' },
  repeat: { type: 'boolean' },
  'cell-size': { type: 'string' },
  regularity: { type: 'string' },
  wobble: { type: 'string' },
  light: { type: 'string' },
  seed: { type: 'string' },
  supersample: { type: 'string' },
  threads: { type: 'string' },
  quality: { type: 'string' },
  effort: { type: 'string' },
  lossless: { type: 'boolean' },
  config: { type: 'string' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Raw = { readonly [key: string]: string | boolean | number | undefined };

const num = (raw: Raw, key: string, fallback: number, lo: number, hi: number): number => {
  const v = raw[key];
  if (v === undefined) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new UsageError(`--${key} must be a number from ${lo} to ${hi} (got "${v}")`);
  return n;
};

const optNum = (raw: Raw, key: string, lo: number, hi: number): number | undefined =>
  raw[key] === undefined ? undefined : num(raw, key, 0, lo, hi);

const oneOf = <T extends string>(raw: Raw, key: string, choices: readonly T[], fallback: T): T => {
  const v = raw[key] === undefined ? fallback : String(raw[key]).toLowerCase();
  if (!(choices as readonly string[]).includes(v)) throw new UsageError(`--${key} must be one of ${choices.join(', ')} (got "${v}")`);
  return v as T;
};

const formatFromName = (file: string): Format | undefined => {
  const ext = extname(file).slice(1).toLowerCase();
  const map: { readonly [k: string]: Format } = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', jxl: 'jxl', avif: 'avif' };
  return map[ext];
};

const parseSize = (raw: Raw): { readonly width: number; readonly height: number } => {
  const size = raw.size === undefined ? undefined : String(raw.size);
  const m = size === undefined ? null : /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size);
  if (size !== undefined && !m) throw new UsageError(`--size must look like 1920x1080 (got "${size}")`);
  const base = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 2048, height: 2048 };
  const width = num(raw, 'width', base.width, 16, 16384);
  const height = num(raw, 'height', base.height, 16, 16384);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new UsageError('Width and height must be whole numbers');
  return { width, height };
};

const parseLight = (raw: Raw): { readonly lightAzimuth: number; readonly lightElevation: number } => {
  const text = raw.light === undefined ? '135,45' : String(raw.light);
  const parts = text.split(',').map((s) => Number(s.trim()));
  const [az, el] = parts;
  if (parts.length !== 2 || !Number.isFinite(az) || !Number.isFinite(el) || el! <= 0 || el! > 90) {
    throw new UsageError(`--light must be "azimuth,elevation" in degrees with 0 < elevation <= 90 (got "${text}")`);
  }
  return { lightAzimuth: az!, lightElevation: el! };
};

/** Turn merged raw values (config file + flags) into validated options. */
export const resolveOptions = (raw: Raw): Options => {
  const output = raw.output === undefined ? '' : String(raw.output);
  if (!output) throw new UsageError('Missing --output <file>');
  const format = raw.format !== undefined ? formatFromName(`.${String(raw.format)}`) : formatFromName(output);
  if (format === undefined) {
    throw new UsageError(
      raw.format !== undefined
        ? `--format must be one of ${FORMATS.join(', ')} (got "${raw.format}")`
        : `Cannot tell the format from "${output}"; use a .png/.jpg/.jxl/.avif extension or --format`,
    );
  }
  const style = oneOf(raw, 'style', STYLES, 'realistic');
  if (style === 'stylized' && raw.finish !== undefined) throw new UsageError('--finish only applies to --style realistic');
  const finish = oneOf(raw, 'finish', FINISHES, 'polished');
  const palette = oneOf(raw, 'palette', PALETTE_NAMES, 'natural');
  const colors = raw.colors === undefined ? [] : String(raw.colors).split(',').map((s) => s.trim());
  if (palette === 'custom' && (colors.length < 3 || colors.length > 5)) throw new UsageError('--palette custom needs --colors wall,body,eye[,septa,matrix]');
  if (palette !== 'custom' && colors.length > 0) throw new UsageError('--colors requires --palette custom');
  const badColor = colors.find((c) => !isHexColor(c));
  if (badColor !== undefined) throw new UsageError(`Invalid color "${badColor}" in --colors (expected #rrggbb)`);
  const shape = oneOf(raw, 'shape', SHAPES, 'rect');
  const repeat = raw.repeat === true;
  if (repeat && shape !== 'rect') throw new UsageError('--repeat only works with --shape rect');
  const background = raw.background === undefined ? 'transparent' : String(raw.background).trim().toLowerCase();
  if (background !== 'transparent' && !isHexColor(background)) throw new UsageError(`--background must be "transparent" or #rrggbb (got "${background}")`);
  const { width, height } = parseSize(raw);
  const cellSize = num(raw, 'cell-size', 160, 8, 4096);
  if (repeat && (cellSize > width || cellSize > height)) throw new UsageError('--cell-size must not exceed the tile size when using --repeat');
  const supersample = num(raw, 'supersample', 2, 1, 4);
  if (!Number.isInteger(supersample)) throw new UsageError('--supersample must be a whole number from 1 to 4');
  const effortMin = format === 'jxl' ? 1 : 0;
  const lossless = raw.lossless === true;
  if (lossless && (format === 'jpeg' || format === 'png')) throw new UsageError(`--lossless applies to avif and jxl (png is always lossless; jpeg never is)`);
  const quality = optNum(raw, 'quality', 0, 100);
  if (quality !== undefined && format === 'png') throw new UsageError('--quality does not apply to png');
  return {
    output,
    format,
    style,
    finish,
    palette,
    colors,
    width,
    height,
    shape,
    background,
    shadow: raw['no-shadow'] === true ? false : raw.shadow !== false,
    repeat,
    cellSize,
    regularity: num(raw, 'regularity', 0.6, 0, 1),
    wobble: num(raw, 'wobble', 0.3, 0, 3),
    ...parseLight(raw),
    seed: raw.seed === undefined ? String(randomInt(1, 2 ** 31 - 1)) : String(raw.seed),
    supersample,
    threads: (() => {
      const n = num(raw, 'threads', availableParallelism(), 1, 256);
      if (!Number.isInteger(n)) throw new UsageError('--threads must be a whole number');
      return n;
    })(),
    quality,
    effort: optNum(raw, 'effort', effortMin, 9),
    lossless,
    verbose: raw.verbose === true,
  };
};

/** Parse argv; returns undefined when help was requested. */
export const parseCommandLine = async (argv: readonly string[]): Promise<Options | undefined> => {
  const { values, positionals } = (() => {
    try {
      return parseArgs({ args: [...argv], options: ARG_SPEC, allowPositionals: true, strict: true });
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  })();
  if (values.help) return undefined;
  if (positionals.length > 0) throw new UsageError(`Unexpected argument "${positionals[0]}"`);
  const fromConfig: Raw = values.config === undefined ? {} : await readConfig(values.config);
  const flags = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Raw;
  return resolveOptions({ ...fromConfig, ...flags });
};

const readConfig = async (file: string): Promise<Raw> => {
  const text = await readFile(file, 'utf8').catch((e: Error) => {
    throw new UsageError(`Cannot read config "${file}": ${e.message}`);
  });
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text.replace(/^﻿/, ''));
    } catch (e) {
      throw new UsageError(`Config "${file}" is not valid JSON: ${(e as Error).message}`);
    }
  })();
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new UsageError(`Config "${file}" must be a JSON object`);
  const known = new Set(Object.keys(ARG_SPEC));
  const unknown = Object.keys(parsed).filter((k) => !known.has(k) || k === 'config' || k === 'help');
  if (unknown.length > 0) throw new UsageError(`Unknown option(s) in config "${file}": ${unknown.join(', ')}`);
  return Object.fromEntries(
    Object.entries(parsed as { [k: string]: unknown }).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v as string | number | boolean)]),
  );
};
