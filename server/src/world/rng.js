// Seeded xorshift32 RNG — deterministic given the same seed.
export class RNG {
  constructor(seed = 123456789) { this.seed = seed; }
  next() {
    let x = this.seed |= 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x;
    return (x >>> 0) / 4294967296;
  }
  range(min, max) { return min + (max - min) * this.next(); }
  pick(a) { return a[(this.next() * a.length) | 0]; }
}