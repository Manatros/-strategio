import { RNG } from "./rng";
export function valueNoise2D(w:number,h:number,scale=16,seed=1337){
  const rng = new RNG(seed);
  const gW = Math.ceil(w/scale)+2, gH = Math.ceil(h/scale)+2;
  const grid = Array.from({length:gH},()=>Array.from({length:gW},()=>rng.next()));
  const res = new Float32Array(w*h);
  const lerp=(a:number,b:number,t:number)=>a+(b-a)*t;
  const fade=(t:number)=>t*t*(3-2*t);
  for(let y=0;y<h;y++){
    const gy = y/scale; const y0 = Math.floor(gy); const ty = fade(gy-y0);
    for(let x=0;x<w;x++){
      const gx = x/scale; const x0 = Math.floor(gx); const tx = fade(gx-x0);
      const v00 = grid[y0][x0], v10 = grid[y0][x0+1];
      const v01 = grid[y0+1][x0], v11 = grid[y0+1][x0+1];
      const v0 = lerp(v00,v10,tx); const v1 = lerp(v01,v11,tx);
      res[y*w+x] = lerp(v0,v1,ty);
    }
  }
  return res;
}
