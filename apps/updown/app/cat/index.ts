// Public entry. Nothing here imports three.js: the overlay (three + drei + glb) is a lazy chunk loaded by CatLayer, so
// the game paints and plays before it arrives. Mount `<CatMoodProvider><CatLayer/>…</CatMoodProvider>` once at the
// app shell; pages push a pose with `useCatMood().set(pose)` (or render `<CatHome pose={pose}/>`, which also marks
// Cato's spot, the `[data-cat-home]` anchor the cat goes to).
export { CatLayer, CatOverlay, type CatLayerProps } from './CatLayer';
export type { CatOverlayProps } from './CatOverlay';
export { CatHome, type CatHomeProps } from './CatHome';
export { CatMoodProvider, useCatMood, createCatMoodStore, type CatMoodApi, type CatMoodStore, type CatOverlayStatus } from './CatMood';
export { catSupported, prefersReducedMotion } from './support';
export { CatProvider, useCat, type CatApi } from './CatContext';
export type { CatClip } from './brain';
