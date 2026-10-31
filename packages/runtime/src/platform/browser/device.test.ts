import { describe, expect, it } from 'vitest';
import { isAndroidWebView, markWebGpuFailed, probeDevice, probeGpu } from './device.js';
import type { DeviceHost } from './device.js';

const PIXEL_WEBVIEW = 'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36';
const PIXEL_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

function host(userAgent: string, extra: Partial<DeviceHost['navigator']> = {}, session = new Map<string, string>()): DeviceHost {
  return {
    navigator: { userAgent, ...extra },
    screen: { width: 412, height: 915 },
    sessionStorage: { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => { session.set(k, v); } },
  };
}

describe('probeDevice', () => {
  it('forces WebGL2 in Android WebViews, not in Android Chrome', () => {
    expect(isAndroidWebView(PIXEL_WEBVIEW)).toBe(true);
    expect(isAndroidWebView(PIXEL_CHROME)).toBe(false);
    expect(probeDevice(host(PIXEL_WEBVIEW, { hardwareConcurrency: 8, deviceMemory: 8 }))).toMatchObject({ renderer: 'webgl2', webview: true, mobile: true, tier: 'medium' });
    expect(probeDevice(host(PIXEL_CHROME, { hardwareConcurrency: 8, deviceMemory: 8 })).renderer).toBeUndefined();
  });

  it('tiers: low-end phones low, phones medium, small desktops medium, the rest high', () => {
    expect(probeDevice(host(PIXEL_CHROME, { hardwareConcurrency: 4, deviceMemory: 4 })).tier).toBe('low');
    expect(probeDevice(host(PIXEL_CHROME, { hardwareConcurrency: 8 })).tier).toBe('medium');
    expect(probeDevice({ navigator: { userAgent: DESKTOP, hardwareConcurrency: 4 } }).tier).toBe('medium');
    expect(probeDevice({ navigator: { userAgent: DESKTOP, hardwareConcurrency: 12, deviceMemory: 8 } }).tier).toBe('high');
    expect(probeDevice({ navigator: { userAgent: DESKTOP, deviceMemory: 2 } }).tier).toBe('low');
  });

  it('remembers a WebGPU failure for the rest of the tab\'s session', () => {
    const session = new Map<string, string>();
    expect(probeDevice(host(DESKTOP, {}, session)).renderer).toBeUndefined();
    markWebGpuFailed(host(DESKTOP, {}, session));
    expect(probeDevice(host(DESKTOP, {}, session))).toMatchObject({ renderer: 'webgl2', reasons: ['WebGPU failed earlier in this tab'] });
  });

  it('a software WebGPU adapter means WebGL2 and the low tier', async () => {
    const soft = host(DESKTOP, { gpu: { requestAdapter: async () => ({ isFallbackAdapter: true }) } });
    expect(await probeGpu(probeDevice(soft), soft)).toMatchObject({ renderer: 'webgl2', tier: 'low' });
    const real = host(DESKTOP, { hardwareConcurrency: 16, gpu: { requestAdapter: async () => ({ isFallbackAdapter: false }) } });
    expect(await probeGpu(probeDevice(real), real)).toMatchObject({ renderer: undefined });
  });
});
