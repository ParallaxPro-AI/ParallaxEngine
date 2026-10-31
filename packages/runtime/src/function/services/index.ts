/**
 * Services: interfaces one plugin provides and others use, through `kernel.provide(key, impl)`
 * and `kernel.service(key)`. This is how plugins cooperate (navigation reads terrain
 * heights, characters move through the 3D physics world) without importing each other.
 * Each service lives in its own file here, owned by the plugin that provides it; files hold
 * interfaces and keys only — no behavior.
 */

export {};
export * from './terrain.js';
export * from './environment.js';
export * from './physics3d.js';
export * from './save.js';
export * from './players.js';
export * from './voxels.js';
export * from './streaming.js';
export * from './story.js';
export * from './animation.js';
export * from './poses.js';
export * from './actions.js';
export * from './models.js';
export * from './physics2d.js';
export * from './nav.js';
export * from './ai.js';
export * from './perception.js';
export * from './fog_of_war.js';
export * from './jobs.js';
export * from './characters.js';
export * from './water.js';
export * from './wind.js';
export * from './foliage.js';
export * from './weather.js';
export * from './deformables.js';
export * from './screens.js';
export * from './channels.js';
export * from './procgen.js';
export * from './city.js';
export * from './text.js';
export * from './cameras.js';
export * from './sync.js';
export * from './audio.js';
