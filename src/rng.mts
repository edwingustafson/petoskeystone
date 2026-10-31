// Seeded, deterministic pseudo-random numbers (sfc32 seeded via cyrb128 hash).

export type Rng = {
  readonly next: () => number; // [0, 1)
  readonly uniform: (lo: number, hi: number) => number;
  readonly normal: (mean?: number, sd?: number) => number;
  readonly int: (lo: number, hiInclusive: number) => number;
  readonly pick: <T>(items: readonly T[]) => T;
  readonly u32: () => number;
};

const cyrb128 = (str: string): readonly [number, number, number, number] => {
  const init = [1779033703, 3144134277, 1013904242, 2773480762] as const;
  const [a, b, c, d] = [...str].reduce<readonly [number, number, number, number]>(
    ([h1, h2, h3, h4], ch) => {
      const k = ch.codePointAt(0) ?? 0;
      return [
        h2 ^ Math.imul(h1 ^ k, 597399067),
        h3 ^ Math.imul(h2 ^ k, 2869860233),
        h4 ^ Math.imul(h3 ^ k, 951274213),
        h1 ^ Math.imul(h4 ^ k, 2716044179),
      ];
    },
    init,
  );
  const h1 = Math.imul(c ^ (a >>> 18), 597399067);
  const h2 = Math.imul(d ^ (b >>> 22), 2869860233);
  const h3 = Math.imul(a ^ (c >>> 17), 951274213);
  const h4 = Math.imul(b ^ (d >>> 19), 2716044179);
  const r1 = h1 ^ h2 ^ h3 ^ h4;
  return [r1 >>> 0, (h2 ^ r1) >>> 0, (h3 ^ r1) >>> 0, (h4 ^ r1) >>> 0];
};

/** Create a generator from a seed string; `label` derives independent sub-streams. */
export const createRng = (seed: string, label = ''): Rng => {
  const state = new Uint32Array(cyrb128(`${seed}\u0000${label}`));
  const u32 = (): number => {
    const t = (((state[0]! + state[1]!) >>> 0) + state[3]!) >>> 0;
    state[3] = (state[3]! + 1) >>> 0;
    state[0] = state[1]! ^ (state[1]! >>> 9);
    state[1] = (state[2]! + (state[2]! << 3)) >>> 0;
    state[2] = ((state[2]! << 21) | (state[2]! >>> 11)) >>> 0;
    state[2] = (state[2]! + t) >>> 0;
    return t;
  };
  Array.from({ length: 12 }).forEach(u32); // warm up
  const next = (): number => u32() / 4294967296;
  const uniform = (lo: number, hi: number): number => lo + (hi - lo) * next();
  const normal = (mean = 0, sd = 1): number => {
    const u = Math.max(next(), 1e-12);
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  const int = (lo: number, hiInclusive: number): number =>
    lo + Math.floor(next() * (hiInclusive - lo + 1));
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  return { next, uniform, normal, int, pick, u32 };
};

/** A 32-bit integer derived from a seed string and label (for hash-based noise). */
export const seedInt = (seed: string, label: string): number => createRng(seed, label).u32();
