// sim/rng.ts
// Our own tiny seeded random number generator. No dependencies.
//
// Why seeded? Same seed => same numbers => same episode, byte for byte.
// That makes every bug reproducible and every eval number repeatable.
//
// mulberry32 is a well-known 32-bit generator: fast, small, good enough
// for simulation (NOT for cryptography).

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // in [0, 1)
  };
}

// FNV-1a: turns a string into a 32-bit number. Used to derive sub-seeds.
export function hashString(s: string, salt = 0): number {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  // uniform number in [a, b)
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  // whole number in [a, b], both ends included
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  // bell curve sample (Box-Muller transform)
  normal(mean: number, sd: number): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  // waiting time until the next event of a process that happens `rate` times per unit
  exponential(rate: number): number {
    return -Math.log(1 - this.next()) / rate;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

// A separate, independent random stream for one purpose, e.g.
// rngFor(seed, "bg:drn-z03-1"). Different labels never share numbers, so
// changing one part of an episode does not reshuffle every other part.
// This is what lets twin episodes share an identical prefix.
export function rngFor(seed: number, label: string): Rng {
  return new Rng(hashString(label, seed) ^ Math.imul(seed, 0x9e3779b1));
}

// A short id that looks random but is fully determined by seed + label.
// 12 hex chars from two independent hashes, so collisions are very unlikely.
export function stableId(seed: number, label: string): string {
  const a = hashString(label, seed ^ 0x1234567).toString(16).padStart(8, "0");
  const b = hashString(label, seed ^ 0x7654321).toString(16).padStart(8, "0");
  return a + b.slice(0, 4);
}
