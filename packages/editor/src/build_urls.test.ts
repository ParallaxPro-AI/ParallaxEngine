import { describe, expect, it } from 'vitest';
import { BuildUrls } from './build_urls.js';

describe('build URLs for runtime rebuilds (build_urls.ts)', () => {
  const numbered = (n: number): string => `/build/v${n}/`;

  it('loads a new build\'s URL as it is', () => {
    const urls = new BuildUrls(numbered);
    urls.loaded('/build/v1/');
    expect(urls.next('/build/v2/')).toBe('/build/v2/');
  });

  it('never loads a URL twice: a rebuild on the running build gets a fresh number (PP9153)', () => {
    const urls = new BuildUrls(numbered);
    urls.loaded('/build/v1/');
    const again = urls.next('/build/v1/');
    expect(again).toMatch(/^\/build\/v\d+\/$/);
    expect(again).not.toBe('/build/v1/');
    const third = urls.next('/build/v1/');
    expect(new Set(['/build/v1/', again, third]).size).toBe(3);
    // Another server's build (a swapped-in settled version) is tracked too.
    expect(urls.next('/play/build/v9/')).toBe('/play/build/v9/');
    expect(urls.next('/play/build/v9/')).not.toBe('/play/build/v9/');
  });
});
