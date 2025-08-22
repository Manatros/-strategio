export class RNG {
  constructor(public seed = 123456789) {}
  next() {
    // xorshift32
    let x = this.seed |= 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x;
    return (x >>> 0) / 4294967296;
  }
  range(min:number,max:number){ return min + (max-min)*this.next(); }
  pick<T>(a:T[]){ return a[(this.next()*a.length)|0]; }
}
