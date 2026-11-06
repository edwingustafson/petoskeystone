// Color palettes, stored and mixed in linear-light RGB.

export type Rgb = readonly [number, number, number];

/** Roles that make up a Petoskey stone's coloring. */
export type Palette = {
  readonly wall: Rgb; // pale corallite walls
  readonly septa: Rgb; // radiating ridges
  readonly body: Rgb; // outer radial zone
  readonly bodyInner: Rgb; // inner radial zone, near the eye
  readonly eye: Rgb; // dark center (calyx)
  readonly matrix: Rgb; // patternless rock
};

type HexPalette = { readonly [K in keyof Palette]: string };

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

export const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

const LUT_SIZE = 4096;
const SRGB_LUT = Uint8Array.from({ length: LUT_SIZE + 1 }, (_, i) => Math.round(255 * linearToSrgb(i / LUT_SIZE)));

/** Linear [0,1] → 8-bit sRGB (clamped). */
export const toSrgb8 = (lin: number): number =>
  SRGB_LUT[lin <= 0 ? 0 : lin >= 1 ? LUT_SIZE : (lin * LUT_SIZE + 0.5) | 0]!;

const HEX_RE =/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export const isHexColor = (s: string): boolean => HEX_RE.test(s.trim());

/** Parse `#rgb` / `#rrggbb` into linear RGB. */
export const parseHex = (s: string): Rgb => {
  const m = HEX_RE.exec(s.trim());
  if (!m) throw new Error(`Invalid color "${s}" (expected #rrggbb)`);
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  return [r!, g!, b!];
};

export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const fromHex = (p: HexPalette): Palette => ({
  wall: parseHex(p.wall),
  septa: parseHex(p.septa),
  body: parseHex(p.body),
  bodyInner: parseHex(p.bodyInner),
  eye: parseHex(p.eye),
  matrix: parseHex(p.matrix),
});

/** Natural colors, picked by eye from reference photos of polished stones. */
const PRESETS: { readonly [name: string]: HexPalette } = {
  natural: {
    wall: '#e4dccd',
    septa: '#cfc4b2',
    body: '#8c7f70',
    bodyInner: '#6e6458',
    eye: '#3e362d',
    matrix: '#6f675d',
  },
  ocean: {
    wall: '#e8f4f2',
    septa: '#9fd3d0',
    body: '#2f7f8c',
    bodyInner: '#1d5a6b',
    eye: '#0b2a3c',
    matrix: '#3b5d66',
  },
  ember: {
    wall: '#ffe9c7',
    septa: '#ffb36b',
    body: '#d2552e',
    bodyInner: '#9c2f1c',
    eye: '#3a0d0a',
    matrix: '#6b2a1b',
  },
  moss: {
    wall: '#eef0d2',
    septa: '#b9c98a',
    body: '#6e8a3e',
    bodyInner: '#4d6a2a',
    eye: '#1f2f14',
    matrix: '#4a5536',
  },
  mono: {
    wall: '#f5f5f5',
    septa: '#c8c8c8',
    body: '#808080',
    bodyInner: '#5a5a5a',
    eye: '#1a1a1a',
    matrix: '#6a6a6a',
  },
  neon: {
    wall: '#f9f871',
    septa: '#ff6ec7',
    body: '#7b2ff7',
    bodyInner: '#4b0fa8',
    eye: '#0d0221',
    matrix: '#2d1b69',
  },
  sandstone: {
    wall: '#fbf1de',
    septa: '#e6c9a0',
    body: '#c28f5c',
    bodyInner: '#a06b3e',
    eye: '#5a3720',
    matrix: '#8c6a4f',
  },
  // Retro terminal themes: dark phosphor-tinted backgrounds, kept dim enough that
  // bright green (#33ff33) or amber (#ffb000) text stays readable on top
  // (wall-to-text contrast is about 7:1), with the pattern still visible.
  green: {
    wall: '#174d22',
    septa: '#103a19',
    body: '#0a2610',
    bodyInner: '#061a0a',
    eye: '#020a04',
    matrix: '#081d0c',
  },
  amber: {
    wall: '#4d3207',
    septa: '#3a2505',
    body: '#261803',
    bodyInner: '#1a1002',
    eye: '#0a0601',
    matrix: '#1d1203',
  },
};

export const PALETTE_NAMES: readonly string[] = [...Object.keys(PRESETS), 'custom'];

/** Build a palette from `wall,body,eye[,septa,matrix]`, deriving the rest. */
export const customPalette = (colors: readonly string[]): Palette => {
  if (colors.length < 3 || colors.length > 5) {
    throw new Error('--colors needs 3 to 5 hex colors: wall,body,eye[,septa,matrix]');
  }
  const [wall, body, eye] = colors.slice(0, 3).map(parseHex) as [Rgb, Rgb, Rgb];
  const septa = colors[3] ? parseHex(colors[3]) : mixRgb(wall, body, 0.35);
  const matrix = colors[4] ? parseHex(colors[4]) : mixRgb(body, eye, 0.2);
  return { wall, septa, body, bodyInner: mixRgb(body, eye, 0.3), eye, matrix };
};

export const getPalette = (name: string, colors?: readonly string[]): Palette => {
  if (name === 'custom') return customPalette(colors ?? []);
  const preset = PRESETS[name];
  if (!preset) throw new Error(`Unknown palette "${name}" (choose from ${PALETTE_NAMES.join(', ')})`);
  return fromHex(preset);
};
