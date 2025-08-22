export type Axial = { q:number; r:number };
export type Tile = {
  q:number; r:number;
  kind:"Grass"|"Stone"|"Water"|"Fields"|"Snow"|"Forest"|"Bridge";
  elev:number;
  resLeft?: number; // limited resources per tile (optional)
};
export type MapData = { radius:number; hexSize:number; tiles: Map<string,Tile> };
export const key = (q:number,r:number)=> `${q},${r}`;
export const dirs: Axial[] = [
  {q: 1,r:0},{q: 1,r:-1},{q:0,r:-1},
  {q:-1,r:0},{q:-1,r:1},{q:0,r:1}
];
