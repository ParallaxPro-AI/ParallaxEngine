/**
 * What kind of device the game is on, before anything is drawn: which GPU API to trust
 * and the default quality tier (`Settings.quality` on a first run — a saved profile keeps
 * the player's choice).
 *
 * WebGL2 is forced where WebGPU is known to be unreliable:
 *
 *   Android WebView   app shells (`; wv)` in the user agent): WebGPU init throws, or the
 *                     device is lost mid-session, or Vulkan pipelines fail to build
 *   software adapter  `isFallbackAdapter` (SwiftShader): correct but far slower than WebGL2
 *   this session      WebGPU already failed in this tab (`markWebGpuFailed`, kept in
 *                     sessionStorage so a new tab tries WebGPU again)
 *
 * Tiers, from what the browser tells (`deviceMemory` is Chromium-only, so its absence
 * is not "low"):
 *
 *   low     ≤ 2 GB, or a phone with ≤ 4 cores or ≤ 3 GB, or a software adapter
 *   medium  other phones and tablets, ≤ 4 GB, or ≤ 4 cores
 *   high    the rest
 */

export type QualityTier = 'low' | 'medium' | 'high';

export interface DeviceHost {
  readonly navigator: {
    readonly userAgent: string;
    readonly hardwareConcurrency?: number;
    readonly deviceMemory?: number;
    readonly maxTouchPoints?: number;
    readonly gpu?: { requestAdapter(options?: object): Promise<{ readonly isFallbackAdapter?: boolean; readonly info?: { readonly vendor?: string; readonly architecture?: string } } | null> };
  };
  readonly screen?: { readonly width: number; readonly height: number };
  readonly sessionStorage?: Pick<Storage, 'getItem' | 'setItem'>;
}

export interface DeviceProfile {
  readonly tier: QualityTier;
  /** 'webgl2' when WebGPU must not be used here; undefined: try WebGPU first. */
  readonly renderer: 'webgl2' | undefined;
  readonly mobile: boolean;
  readonly webview: boolean;
  /** Why, one phrase each (logged at boot). */
  readonly reasons: readonly string[];
}

const FAILED_KEY = 'parallax:webgpu-failed';

function session(host: DeviceHost): DeviceHost['sessionStorage'] | undefined {
  try {
    return host.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Remember that WebGPU failed in this tab: the next boot (a reload) draws with WebGL2. */
export function markWebGpuFailed(host: DeviceHost = globalThis as unknown as DeviceHost): void {
  try { session(host)?.setItem(FAILED_KEY, '1'); } catch { /* storage blocked: the next boot tries WebGPU again */ }
}

function failedBefore(host: DeviceHost): boolean {
  try { return session(host)?.getItem(FAILED_KEY) === '1'; } catch { return false; }
}

export function isAndroidWebView(userAgent: string): boolean {
  return /Android/.test(userAgent) && (/; wv\)/.test(userAgent) || /Version\/[\d.]+ Chrome\//.test(userAgent));
}

/** The synchronous part: user agent, cores, memory, screen, this session's history. */
export function probeDevice(host: DeviceHost = globalThis as unknown as DeviceHost): DeviceProfile {
  const nav = host.navigator;
  const ua = nav.userAgent;
  const reasons: string[] = [];
  const webview = isAndroidWebView(ua);
  const shortSide = host.screen === undefined ? Infinity : Math.min(host.screen.width, host.screen.height);
  const mobile = /Android|iPhone|iPad|iPod|Mobile/.test(ua) || ((nav.maxTouchPoints ?? 0) > 1 && shortSide < 900);
  let renderer: 'webgl2' | undefined;
  if (webview) { renderer = 'webgl2'; reasons.push('Android WebView: WebGPU is unreliable there'); }
  if (failedBefore(host)) { renderer = 'webgl2'; reasons.push('WebGPU failed earlier in this tab'); }

  const cores = nav.hardwareConcurrency;
  const memory = nav.deviceMemory;
  let tier: QualityTier = 'high';
  if (memory !== undefined && memory <= 2) { tier = 'low'; reasons.push(`${memory} GB of memory`); }
  else if (mobile && ((cores !== undefined && cores <= 4) || (memory !== undefined && memory <= 3))) { tier = 'low'; reasons.push('a low-end phone'); }
  else if (mobile) { tier = 'medium'; reasons.push('a phone or tablet'); }
  else if ((memory !== undefined && memory <= 4) || (cores !== undefined && cores <= 4)) { tier = 'medium'; reasons.push('4 cores or 4 GB'); }
  return { tier, renderer, mobile, webview, reasons };
}

/** The asynchronous part: ask WebGPU for its adapter (skipped when WebGL2 is forced). */
export async function probeGpu(profile: DeviceProfile, host: DeviceHost = globalThis as unknown as DeviceHost): Promise<DeviceProfile> {
  const gpu = host.navigator.gpu;
  if (profile.renderer === 'webgl2' || gpu === undefined) return profile;
  let adapter;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    return profile;
  }
  if (adapter?.isFallbackAdapter !== true) return profile;
  return { ...profile, renderer: 'webgl2', tier: 'low', reasons: [...profile.reasons, 'WebGPU has only a software adapter'] };
}
