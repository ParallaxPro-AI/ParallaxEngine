/**
 * boot — the composition root. Chooses platform adapters (headless or browser), the
 * plugins a game declares, and starts it. The only layer allowed to import everything.
 *
 *   bootBrowser   a served build in a page: stage, devices, rAF loop, error overlay
 *   bootPlay      a published game from its packed build: /play pages and store exports
 *   FrameStats    per-frame stats for a profiler (fps, phases, scripts, draws), off until enabled
 *   bootHeadless  scriptable input, manual clock and display: playtests, CLI, servers
 *   startGame     the shared part: entry + files + devices → a started GameRuntime
 */

export { bootBrowser, deviceId } from './browser.js';
export type { BrowserBootOptions, BrowserGame } from './browser.js';
export { netFromUrl, openNet, rejoinKey } from './browser_net.js';
export type { BrowserNet, OpenedNet } from './browser_net.js';
export { bundleSources, looseSources } from './browser_sources.js';
export type { GameSources } from './browser_sources.js';
export { buffersOf, ENGINE_JOB_DEFS, ENGINE_JOBS, GLTF_BUILD, MODEL_PARSE, NAV_PATHS, TERRAIN_BAKE, VOXELS_MESH } from './jobs.js';
export type { GltfBuildInput, NavPath, NavPathsInput, VoxelMeshInput, VoxelMeshOutput } from './jobs.js';
export { bootHeadless } from './headless.js';
export type { HeadlessBootOptions, HeadlessGame } from './headless.js';
export { GameLoop } from './loop.js';
export { BUDGET_BUCKETS, budgetOf, distribution, FrameStats } from './frame_stats.js';
export type {
  BudgetBucket, BudgetSlice, Distribution, FrameStatsOptions, FrameStatsSource, HookStat, PerfSnapshot, PhaseStat, RenderStats, UnitStat,
} from './frame_stats.js';
export type { LoopOptions, Steppable } from './loop.js';
export {
  BOOT_ENTRY, ENGINE_MODULES, GAME_EXPORT, gameModules, JOB_WORKER_ENTRY, migrationModules, missingEngineModule, PANEL_FRAME_ENTRY,
  PROJECT_MODULE, PROJECT_MODULE_FILE,
} from './modules.js';
export type { BuildManifest } from './modules.js';
export { bootPlay, fullscreenControl, playFiles } from './play.js';
// The play page's cloud saves, on the boot module it imports.
export { HttpSaveRemote } from '../platform/index.js';
export type { FullscreenControl, PlayAnalytics, PlayBootOptions, PlayEventName, PlayFiles, PlayGame } from './play.js';
export { BootFailure, diagnosticsOf, startGame } from './start.js';
export type { StartedGame, StartOptions } from './start.js';
