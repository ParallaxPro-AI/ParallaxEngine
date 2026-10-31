/**
 * The loading screen's progress mapping and copy, against a minimal stand-in for the page
 * (vitest runs in Node).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BootProgress, bootBytesText, bootOverall, bootStageLabel, bootStepText, FADE_SECONDS, formatBytes, SLOW_HINT_SECONDS } from './boot_progress.js';
import type { BootProgressEvent, BootProgressOptions } from './boot_progress.js';

class FakeElement {
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = '';
  className = '';
  src = '';
  alt = '';
  constructor(readonly ownerDocument: FakeDocument, readonly tagName: string) {}
  append(...nodes: FakeElement[]): void { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  remove(): void {
    if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  find(className: string): FakeElement | undefined {
    if (this.className === className) return this;
    for (const c of this.children) { const hit = c.find(className); if (hit !== undefined) return hit; }
    return undefined;
  }
}

class FakeDocument {
  createElement(tag: string): FakeElement { return new FakeElement(this, tag); }
}

function screen(options?: BootProgressOptions): { stage: FakeElement; progress: BootProgress; clock: { t: number } } {
  const stage = new FakeDocument().createElement('div');
  const clock = { t: 10 };
  const progress = new BootProgress(stage as unknown as HTMLElement, () => clock.t, options);
  return { stage, progress, clock };
}

const text = (stage: FakeElement, className: string): string => stage.find(className)!.textContent;

describe('boot progress mapping', () => {
  it('weights the stages: engine 15%, data 45%, assets 30%, start 10%', () => {
    expect(bootOverall('engine', 0)).toBe(0);
    expect(bootOverall('engine', 1)).toBeCloseTo(0.15);
    expect(bootOverall('data', 0.5)).toBeCloseTo(0.375);
    expect(bootOverall('assets', 0)).toBeCloseTo(0.6);
    expect(bootOverall('start', 1)).toBeCloseTo(1);
  });

  it('clamps a fraction out of range or not a number', () => {
    expect(bootOverall('data', 2)).toBeCloseTo(0.6);
    expect(bootOverall('data', -1)).toBeCloseTo(0.15);
    expect(bootOverall('data', Number.NaN)).toBeCloseTo(0.15);
  });

  it('words each stage', () => {
    expect(bootStepText('engine')).toBe('Step 1 of 4');
    expect(bootStepText('start')).toBe('Step 4 of 4');
    expect(bootStageLabel('data')).toBe('Downloading game data');
    expect(bootStageLabel('assets')).toBe('Downloading assets');
  });

  it('formats download sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(842 * 1024)).toBe('842 KB');
    expect(formatBytes(18.3 * 1024 * 1024)).toBe('18.3 MB');
    expect(bootBytesText(undefined)).toBe('');
    expect(bootBytesText({ loaded: 0, total: 0 })).toBe('');
    expect(bootBytesText({ loaded: 5 * 1024 * 1024, total: 42 * 1024 * 1024 })).toBe('5.0 MB / 42.0 MB downloaded');
    expect(bootBytesText({ loaded: 42 * 1024 * 1024, total: 42 * 1024 * 1024 })).toBe('42.0 MB downloaded');
  });
});

describe('BootProgress', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows the stage, bytes, bar and percent, and never goes back', () => {
    const { stage, progress, clock } = screen();
    const events: BootProgressEvent[] = [];
    progress.onProgress((e) => events.push(e));
    expect(text(stage, 'parallax-loading-step')).toBe('Step 1 of 4');
    expect(text(stage, 'parallax-loading-percent')).toBe('0%');

    clock.t = 11;
    progress.update('data', 0.5, { loaded: 1024 * 1024, total: 2 * 1024 * 1024 });
    expect(text(stage, 'parallax-loading-step')).toBe('Step 2 of 4');
    expect(text(stage, 'parallax-loading-text')).toBe('Downloading game data');
    expect(text(stage, 'parallax-loading-detail')).toBe('1.0 MB / 2.0 MB downloaded');
    expect(stage.find('parallax-loading-fill')!.style.width).toBe('37.5%');
    expect(text(stage, 'parallax-loading-percent')).toBe('37%');
    expect(events.at(-1)).toMatchObject({ stage: 'data', fraction: 0.5, seconds: 1, bytes: { loaded: 1024 * 1024 } });

    // An earlier stage reporting late (engine and data load together) moves nothing.
    progress.update('engine', 1);
    expect(text(stage, 'parallax-loading-text')).toBe('Downloading game data');
    progress.update('data', 0.25);
    expect(progress.overall).toBeCloseTo(0.375);

    progress.update('assets', 0);
    expect(text(stage, 'parallax-loading-text')).toBe('Downloading assets');
    // The download's size stays on the detail line through the later stages.
    expect(text(stage, 'parallax-loading-detail')).toBe('1.0 MB / 2.0 MB downloaded');
    expect(progress.timings.map((t) => t.stage)).toEqual(['engine', 'data', 'assets']);
  });

  it('shows the brand splash for players and not in an editor', () => {
    const played = screen();
    const splash = played.stage.find('parallax-loading-splash')!;
    expect(splash.children[0]!.src.startsWith('data:image/png;base64,')).toBe(true);
    expect(splash.children[0]!.alt).toBe('ParallaxPro');
    expect(screen({ splash: false }).stage.find('parallax-loading-splash')).toBeUndefined();
  });

  it('takes a host\'s logo, wordmark and colors, and keeps the default look without them', () => {
    const branded = screen({ branding: { logo: 'https://example.com/studio.png', wordmark: 'Studio', accent: '#0a0', background: '#000' } });
    const splash = branded.stage.find('parallax-loading-splash')!;
    expect(splash.children[0]!.src).toBe('https://example.com/studio.png');
    expect(splash.children[0]!.alt).toBe('Studio');
    expect(text(branded.stage, 'parallax-loading-wordmark')).toBe('Studio');
    expect(branded.stage.find('parallax-loading-fill')!.style['background']).toBe('#0a0');
    expect(branded.stage.find('parallax-loading')!.style['background']).toBe('#000');
    // Only a wordmark: no image; neither: no splash at all.
    const wordOnly = screen({ branding: { logo: null, wordmark: 'Studio' } }).stage.find('parallax-loading-splash')!;
    expect(wordOnly.children.map((c) => c.className)).toEqual(['parallax-loading-wordmark']);
    expect(screen({ branding: { logo: null } }).stage.find('parallax-loading-splash')).toBeUndefined();
    const plain = screen().stage;
    expect(plain.find('parallax-loading-fill')!.style['background']).toBe('#8648e6');
    expect(plain.find('parallax-loading-progress')!.style['background']).toBe('rgba(134, 72, 230, 0.2)');
    expect(plain.find('parallax-loading-wordmark')).toBeUndefined();
  });

  it('hints at a slow connection after 15 s', () => {
    const { stage } = screen();
    vi.advanceTimersByTime(SLOW_HINT_SECONDS * 1000 - 1);
    expect(text(stage, 'parallax-loading-hint')).toBe('');
    vi.advanceTimersByTime(1);
    expect(text(stage, 'parallax-loading-hint')).toContain('Slow connection');
  });

  it('fades out when the game starts, then leaves the stage', () => {
    const { stage, progress } = screen();
    progress.finish();
    expect(progress.overall).toBe(1);
    expect(text(stage, 'parallax-loading-percent')).toBe('100%');
    expect(progress.element.style.opacity).toBe('0');
    expect(stage.children).toHaveLength(1);
    vi.advanceTimersByTime(FADE_SECONDS * 1000 + 50);
    expect(stage.children).toHaveLength(0);
    expect(progress.timings.at(-1)!.stage).toBe('ready');
    // No slow hint once the game runs.
    vi.advanceTimersByTime(SLOW_HINT_SECONDS * 1000);
    expect(text(progress.element as unknown as FakeElement, 'parallax-loading-hint')).toBe('');
  });

  it('leaves at once for the error overlay', () => {
    const { stage, progress } = screen();
    progress.remove();
    expect(stage.children).toHaveLength(0);
  });
});
