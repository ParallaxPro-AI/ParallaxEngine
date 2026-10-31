/**
 * platform — adapters implementing core's ports for a concrete machine.
 *
 *   headless/  deterministic, no browser: playtests, the multiplayer server; inline jobs,
 *              in-memory bundles and save remote
 *   browser/   the page: HTTP project files and bundles (Range), performance clock, localStorage,
 *              input devices, Web Audio, the Canvas2D surface, the WebGPU/WebGL2 surface, the stage
 *              element, the panel (UI) surface, rAF and visibility, the error overlay, the
 *              loading bar, Web Worker jobs, the device probe, the `/api/game-saves` remote
 *   sync/      platform-neutral: `CloudStore` (local-first cloud saves over any SaveRemote)
 *
 * Only `boot` imports this layer; the engine itself sees ports, never adapters.
 */

export { InMemoryFiles } from './headless/in_memory_files.js';
export { HeadlessAudio } from './headless/audio.js';
export { ManualClock } from './headless/manual_clock.js';
export { ManualDisplay } from './headless/manual_display.js';
export { MemoryStore } from './headless/memory_store.js';
export { RecordingSurface2d } from './headless/render.js';
export { RecordingUiSurface } from './headless/ui.js';
export { frameTextures, MemoryBinaryFiles, RecordingSurface3d } from './headless/render3d.js';
export type { RecordingSurface3dOptions } from './headless/render3d.js';

export { WebAudioOutput } from './browser/audio.js';
export type { AudioContextLike, WebAudioOptions } from './browser/audio.js';
export { PerformanceClock } from './browser/clock.js';
export { BrowserDisplay } from './browser/display.js';
export type { DisplayHost } from './browser/display.js';
export { fetchProjectFiles, TEXT_FILE } from './browser/http_files.js';
export type { FetchedProject, FetchProjectOptions } from './browser/http_files.js';
export { BrowserInput } from './browser/input.js';
export type { BrowserInputOptions, InputHost } from './browser/input.js';
export { LocalStore } from './browser/local_store.js';
export type { WebStorage } from './browser/local_store.js';
export { ErrorOverlay } from './browser/overlay.js';
export { decodeLines, formatTraceback, pythonTraceback } from './browser/traceback.js';
export type { PyFrame, TraceSources } from './browser/traceback.js';
export { CanvasSurface2d, decodeImageBlob } from './browser/render.js';
export type { CanvasSurfaceOptions } from './browser/render.js';
export { HttpBinaryFiles } from './browser/render3d/files.js';
export { selectBackend } from './browser/render3d/select.js';
export { BrowserSurface3d, createBrowserSurface3d } from './browser/render3d/surface.js';
export type { BrowserSurface3dOptions, CreateSurface3dOptions } from './browser/render3d/surface.js';
export { countPlan } from './browser/render3d/plan_counts.js';
export type { DrawCounts, DrawPass } from './browser/render3d/plan_counts.js';
export { createStage } from './browser/stage.js';
export { TouchControls } from './browser/touch.js';
export type { TouchControlsOptions, TouchHost } from './browser/touch.js';
export { DomUiSurface, FRAME_PRESS_EVENT } from './browser/ui/surface.js';
export type { DomUiSurfaceOptions } from './browser/ui/surface.js';
export type { FrameFiles } from './browser/ui/frame_host.js';
export type { Stage } from './browser/stage.js';
export { LoopbackNetwork } from './headless/net.js';
export type { LoopbackOptions, LoopbackTraffic } from './headless/net.js';
export { MemorySignalingHub } from './headless/net_signaling.js';
export { WebSocketLink } from './browser/net.js';
export type { WebSocketLike } from './browser/net.js';
export { WebSocketLobby, WebSocketSignaling } from './browser/net_signaling.js';
export { browserPeer, WebRtcLink, WebRtcListener } from './browser/net_webrtc.js';
export type { CreatePeer, RtcDataChannelLike, RtcDescription, RtcPeerConnectionLike } from './browser/net_webrtc.js';
export { InlineJobs, jobError, jobFailure, jobTable, lookupJob, runHere, transferList } from './headless/jobs.js';
export { defaultThreads, serveJobs, WorkerJobs } from './browser/jobs.js';
export type { WorkerJobsOptions, WorkerLike } from './browser/jobs.js';
export { gunzipBytes, MemoryBundles, sha256Hex } from './headless/memory_bundles.js';
export { HttpBundles } from './browser/http_bundles.js';
export { CloudStore, newerWins, SYNC_KEY } from './sync/cloud_store.js';
export type { CloudStoreOptions } from './sync/cloud_store.js';
export { MemorySaveRemote } from './headless/save_remote.js';
export { HttpSaveRemote, keyOf, slotOf } from './browser/save_remote.js';
export type { HttpSaveRemoteOptions } from './browser/save_remote.js';
export { isAndroidWebView, markWebGpuFailed, probeDevice, probeGpu } from './browser/device.js';
export type { DeviceHost, DeviceProfile, QualityTier } from './browser/device.js';
export { BootProgress } from './browser/boot_progress.js';
export type { BootBranding, BootBytes, BootProgressEvent, BootProgressOptions, BootStage } from './browser/boot_progress.js';
export { FakePaymentHost } from './headless/payments.js';
export { FakeVoiceNetwork } from './headless/voice.js';
export { RecordingScreens } from './headless/screens.js';
export { HostPagePayments } from './browser/payments.js';
export { WebRtcVoice } from './browser/voice.js';
export { DomScreenSurface, SCREEN_TARGETS } from './browser/screens.js';
