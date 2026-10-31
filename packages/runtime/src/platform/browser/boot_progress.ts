/**
 * The loading screen, in the ParallaxPro play page's look: a brand splash (the logo fades
 * in and out over the first 2.4 s, the loading screen already behind it), then a spinner,
 * the stage ("STEP 2 OF 4" / "Downloading game data"), the bytes of a packed download
 * ("18.3 / 42.0 MB downloaded"), a slow-connection hint after 15 s, a purple bar and the
 * percent. Weighted so the bar moves steadily (downloads by bytes, the rest by step); it
 * never goes back. When the game starts the screen fades out; the error overlay replaces
 * it at once when boot fails. `timings` ends with 'ready' (the first frame).
 *
 * A host may bring its own logo, wordmark and colors (`BootBranding`); the default is the
 * ParallaxPro look.
 *
 * The splash never delays the game: it is one CSS animation over the screen, and the
 * screen leaves (splash and all) as soon as the first frame is ready.
 */

import { BRAND_LOGO } from './brand_logo.js';

export type BootStage = 'engine' | 'data' | 'assets' | 'start';

/** Share of the bar each stage fills. */
const WEIGHT: Readonly<Record<BootStage, number>> = { engine: 0.15, data: 0.45, assets: 0.3, start: 0.1 };
const ORDER: readonly BootStage[] = ['engine', 'data', 'assets', 'start'];
/** The default step labels (`editor.loading.step.*`). */
const LABEL: Readonly<Record<BootStage, string>> = {
  engine: 'Loading scripts', data: 'Downloading game data', assets: 'Downloading assets', start: 'Preparing scene',
};

/** Seconds of the logo flash (the play page's `splashFade`). */
export const SPLASH_SECONDS = 2.4;
/** Past this, say something: a stuck-looking boot is usually just slow wifi. */
export const SLOW_HINT_SECONDS = 15;
/** The fade out once the game starts. */
export const FADE_SECONDS = 0.3;

const PURPLE = '#8648e6';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

export interface BootBytes {
  /** Bytes received so far, and the total expected (0: unknown). */
  readonly loaded: number;
  readonly total: number;
}

export interface BootProgressEvent {
  readonly stage: BootStage;
  /** 0..1 within the stage. */
  readonly fraction: number;
  /** 0..1 overall. */
  readonly overall: number;
  /** Seconds since boot began. */
  readonly seconds: number;
  /** A download's bytes, when the stage reports them (packed bundles). */
  readonly bytes?: BootBytes;
}

/**
 * A host's own look for the loading screen (a site hosting games, a studio's build). Every
 * field is optional: what is left out keeps the default ParallaxPro look.
 */
export interface BootBranding {
  /** The splash image: any URL the page may load (a `data:` URL needs no request). Null: no image. */
  readonly logo?: string | null;
  /** Text under the splash image (a studio or game name). */
  readonly wordmark?: string;
  /** The image's alt text (default: the wordmark; 'ParallaxPro' for the default logo). */
  readonly alt?: string;
  /** The spinner, step and bar color (any CSS color; default #8648e6). */
  readonly accent?: string;
  /** The screen's background (any CSS color; default #111). */
  readonly background?: string;
}

export interface BootProgressOptions {
  /** Show the brand splash first (default true; an editor's viewport turns it off). */
  readonly splash?: boolean;
  /** The splash image, wordmark and colors (default: ParallaxPro's). */
  readonly branding?: BootBranding;
}

/** Overall progress (0..1) for `fraction` (0..1) of the way through `stage`. */
export function bootOverall(stage: BootStage, fraction: number): number {
  const index = ORDER.indexOf(stage);
  const before = ORDER.slice(0, index).reduce((n, s) => n + WEIGHT[s], 0);
  const overall = before + WEIGHT[stage] * Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  // The weights sum to 0.9999…: round off the float noise so a finished boot reads 100%.
  return Math.min(1, Math.round(overall * 1e9) / 1e9);
}

/** The stage chip: "Step 2 of 4" (shown upper-case). */
export function bootStepText(stage: BootStage): string {
  return `Step ${ORDER.indexOf(stage) + 1} of ${ORDER.length}`;
}

/** The label under the chip. */
export function bootStageLabel(stage: BootStage): string {
  return LABEL[stage];
}

/** "842 KB", "18.3 MB": one decimal under 100 of a unit. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The detail line: "18.3 / 42.0 MB downloaded" while a download runs, the total once done. */
export function bootBytesText(bytes: BootBytes | undefined): string {
  if (bytes === undefined || bytes.loaded <= 0 && bytes.total <= 0) return '';
  if (bytes.total > bytes.loaded) return `${formatBytes(bytes.loaded)} / ${formatBytes(bytes.total)} downloaded`;
  return `${formatBytes(bytes.loaded)} downloaded`;
}

/** Keyframes the inline styles can't express; scoped by class names, removed with the screen. */
const CSS = `
@keyframes parallax-loading-spin { to { transform: rotate(360deg); } }
@keyframes parallax-splash-logo {
  0% { opacity: 0; transform: scale(0.92); } 30% { opacity: 1; transform: scale(1); }
  70% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1.02); }
}
@keyframes parallax-splash-out { 0%, 70% { opacity: 1; } 100% { opacity: 0; visibility: hidden; } }
@media (prefers-reduced-motion: reduce) {
  .parallax-loading-spinner { animation-duration: 2.4s !important; }
  .parallax-loading-splash img { animation: none !important; opacity: 1; }
}`;

export class BootProgress {
  readonly #root: HTMLElement;
  readonly #step: HTMLElement;
  readonly #label: HTMLElement;
  readonly #detail: HTMLElement;
  readonly #hint: HTMLElement;
  readonly #bar: HTMLElement;
  readonly #percent: HTMLElement;
  readonly #start: number;
  readonly #listeners: ((e: BootProgressEvent) => void)[] = [];
  /** Every stage reached and when (seconds since boot began), for the console and tests. */
  readonly timings: { stage: BootStage | 'ready'; seconds: number }[] = [];
  readonly #now: () => number;
  #stage: BootStage = 'engine';
  #overall = 0;
  #bytes: BootBytes | undefined;
  #slowTimer: ReturnType<typeof setTimeout> | undefined;
  #gone = false;

  constructor(stage: HTMLElement, now: () => number = () => performance.now() / 1000, options: BootProgressOptions = {}) {
    const doc = stage.ownerDocument;
    const brand = options.branding ?? {};
    const accent = brand.accent ?? PURPLE;
    const background = brand.background ?? '#111';
    // The accent, faded (the track and the spinner's ring): the default look's exact colors.
    const tint = (percent: number): string => (brand.accent === undefined
      ? `rgba(134, 72, 230, ${percent / 100})` : `color-mix(in srgb, ${accent} ${percent}%, transparent)`);
    this.#start = now();
    this.#now = now;
    const el = (tag: string, className: string, style: Partial<Record<string, string>>): HTMLElement => {
      const node = doc.createElement(tag);
      node.className = className;
      Object.assign(node.style, style);
      return node;
    };
    this.#root = el('div', 'parallax-loading', {
      position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '24px', background, color: '#e0e0e0', font: `14px ${FONT}`, zIndex: '5', userSelect: 'none',
      transition: `opacity ${FADE_SECONDS}s ease`,
    });
    this.#root.setAttribute('role', 'progressbar');
    this.#root.setAttribute('aria-valuemin', '0');
    this.#root.setAttribute('aria-valuemax', '100');
    const css = doc.createElement('style');
    css.textContent = CSS;

    const spinner = el('div', 'parallax-loading-spinner', {
      width: '40px', height: '40px', flexShrink: '0', boxSizing: 'border-box', border: `3px solid ${tint(30)}`,
      borderTopColor: accent, borderRadius: '50%', animation: 'parallax-loading-spin 0.8s linear infinite',
    });
    // A fixed-height block: its lines fill in at different moments, and the spinner above must not jump.
    const copy = el('div', 'parallax-loading-copy', {
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', minHeight: '58px', padding: '0 16px', textAlign: 'center',
    });
    this.#step = el('div', 'parallax-loading-step', {
      fontSize: '11px', fontWeight: '600', letterSpacing: '0.8px', textTransform: 'uppercase', color: accent,
    });
    this.#label = el('div', 'parallax-loading-text', { fontSize: '16px', fontWeight: '500' });
    this.#detail = el('div', 'parallax-loading-detail', { fontSize: '12.5px', color: '#9a9aa5', fontVariantNumeric: 'tabular-nums' });
    this.#hint = el('div', 'parallax-loading-hint', { fontSize: '12px', color: '#d8a13a' });
    copy.append(this.#step, this.#label, this.#detail, this.#hint);
    const track = el('div', 'parallax-loading-progress', {
      width: '220px', maxWidth: '70%', height: '4px', flexShrink: '0', background: tint(20), borderRadius: '2px', overflow: 'hidden',
    });
    this.#bar = el('div', 'parallax-loading-fill', { width: '0%', height: '100%', background: accent, borderRadius: '2px', transition: 'width 0.2s ease' });
    track.append(this.#bar);
    this.#percent = el('div', 'parallax-loading-percent', { fontSize: '11px', color: '#6f6f7a', fontVariantNumeric: 'tabular-nums' });
    this.#root.append(css, spinner, copy, track, this.#percent);

    const logoUrl = brand.logo === undefined ? BRAND_LOGO : brand.logo;
    if (options.splash !== false && (logoUrl !== null || brand.wordmark !== undefined)) {
      // Over the loading screen, which is already drawn behind it: no blank frame between the two.
      const splash = el('div', 'parallax-loading-splash', {
        position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: '16px', background, pointerEvents: 'none', animation: `parallax-splash-out ${SPLASH_SECONDS}s ease-in-out forwards`,
      });
      const fade = `parallax-splash-logo ${SPLASH_SECONDS}s ease-in-out forwards`;
      if (logoUrl !== null) {
        const logo = doc.createElement('img') as HTMLImageElement;
        logo.src = logoUrl;
        logo.alt = brand.alt ?? brand.wordmark ?? (brand.logo === undefined ? 'ParallaxPro' : '');
        Object.assign(logo.style, { width: 'min(170px, 40%)', height: 'auto', opacity: '0', animation: fade });
        splash.append(logo);
      }
      if (brand.wordmark !== undefined) {
        const wordmark = el('div', 'parallax-loading-wordmark', {
          fontSize: '20px', fontWeight: '600', letterSpacing: '0.5px', opacity: '0', animation: fade,
        });
        wordmark.textContent = brand.wordmark;
        splash.append(wordmark);
      }
      this.#root.append(splash);
    }
    stage.append(this.#root);
    this.#slowTimer = setTimeout(() => {
      if (!this.#gone) this.#hint.textContent = 'Slow connection — still working…';
    }, SLOW_HINT_SECONDS * 1000);
    this.update('engine', 0);
  }

  get overall(): number {
    return this.#overall;
  }

  /** The screen's element (its class is `parallax-loading`). */
  get element(): HTMLElement {
    return this.#root;
  }

  onProgress(listener: (e: BootProgressEvent) => void): void {
    this.#listeners.push(listener);
  }

  /**
   * Report progress within a stage, with the bytes of a download when known; stages only
   * move forward, the bar never goes back.
   */
  update(stage: BootStage, fraction: number, bytes?: BootBytes): void {
    if (ORDER.indexOf(stage) < ORDER.indexOf(this.#stage)) return;
    const seconds = this.#now() - this.#start;
    if (stage !== this.#stage || this.timings.length === 0) this.timings.push({ stage, seconds });
    this.#stage = stage;
    if (bytes !== undefined) this.#bytes = bytes;
    const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
    this.#overall = Math.max(this.#overall, bootOverall(stage, clamped));
    const percent = Math.floor(this.#overall * 100);
    this.#bar.style.width = `${(this.#overall * 100).toFixed(1)}%`;
    this.#percent.textContent = `${percent}%`;
    this.#root.setAttribute('aria-valuenow', String(percent));
    this.#root.setAttribute('aria-valuetext', `${LABEL[stage]}, ${percent}%`);
    this.#step.textContent = bootStepText(stage);
    this.#label.textContent = LABEL[stage];
    this.#detail.textContent = bootBytesText(this.#bytes);
    for (const listener of this.#listeners) {
      listener({ stage, fraction: clamped, overall: this.#overall, seconds, ...(bytes !== undefined && { bytes }) });
    }
  }

  /** Done: fill the bar, fade the screen out over the first frame, then remove it. */
  finish(): void {
    this.update('start', 1);
    this.timings.push({ stage: 'ready', seconds: this.#now() - this.#start });
    if (this.#gone) return;
    this.#stop();
    Object.assign(this.#root.style, { opacity: '0', pointerEvents: 'none' });
    this.#root.setAttribute('aria-busy', 'false');
    setTimeout(() => this.#root.remove(), FADE_SECONDS * 1000 + 50);
  }

  /** Boot failed: take the screen away at once for the error overlay. */
  remove(): void {
    this.#stop();
    this.#root.remove();
  }

  #stop(): void {
    this.#gone = true;
    if (this.#slowTimer !== undefined) clearTimeout(this.#slowTimer);
    this.#slowTimer = undefined;
  }
}
