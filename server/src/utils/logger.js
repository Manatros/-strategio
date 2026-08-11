const ts = () => new Date().toISOString().replace('T',' ').replace('Z','');
export const log  = (...a) => console.log(`[${ts()}]`, ...a);
export const warn = (...a) => console.warn(`[${ts()}]`, ...a);
export const err  = (...a) => console.error(`[${ts()}]`, ...a);
