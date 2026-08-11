export type Axial = { q:number; r:number };
export type Tile = {
  q:number; r:number;
  kind:"Grass"|"Stone"|"Water"|"Fields"|"Snow"|"Forest"|"Bridge"|"HighMountain";
  elev:number;
  resLeft?: number; // limited resources per tile (optional)
  blocked?: boolean; // locked by an adjacent Dwarf Mine — drained but can't be built on
};
export const key = (q:number,r:number)=> `${q},${r}`;
export const dirs: Axial[] = [
  {q: 1,r:0},{q: 1,r:-1},{q:0,r:-1},
  {q:-1,r:0},{q:-1,r:1},{q:0,r:1}
];
