/**
 * When the editor takes its phone layout: a touch-primary
 * device (touch present AND a coarse primary pointer: a phone or tablet, not a touchscreen
 * laptop), or a window too narrow for the three columns (left 200 + centre 300 + right 200
 * and the resizers). The answer follows the window: rotating or resizing re-evaluates it,
 * and `body.mobile` mirrors it for the stylesheet.
 */

/** At or below this width the desktop columns can't fit. */
export const DESKTOP_MIN_WIDTH = 700;

export interface MobileProbe {
  readonly width: number;
  readonly touch: boolean;
  readonly coarse: boolean;
}

/** The rule itself, on plain numbers (tested without a browser). */
export function wantsMobile(probe: MobileProbe): boolean {
  return (probe.touch && probe.coarse) || probe.width <= DESKTOP_MIN_WIDTH;
}

function probe(): MobileProbe {
  const win = globalThis as typeof globalThis & { visualViewport?: { width: number } | null };
  return {
    width: win.innerWidth ?? Number.POSITIVE_INFINITY,
    touch: 'ontouchstart' in win || (globalThis.navigator?.maxTouchPoints ?? 0) > 0,
    coarse: globalThis.matchMedia?.('(pointer: coarse)')?.matches ?? false,
  };
}

/** Whether the editor should use its phone layout now. */
export function isMobileLayout(): boolean {
  return wantsMobile(probe());
}

/**
 * Call `listener` with the layout now and whenever it flips (resize, rotation, a pointer
 * change); keeps `body.mobile` in step. Returns a function that stops listening.
 */
export function watchMobileLayout(listener: (mobile: boolean) => void): () => void {
  let current = isMobileLayout();
  const apply = (): void => {
    document.body.classList.toggle('mobile', current);
    listener(current);
  };
  const check = (): void => {
    const next = isMobileLayout();
    if (next === current) return;
    current = next;
    apply();
  };
  apply();
  globalThis.addEventListener('resize', check);
  const coarse = globalThis.matchMedia?.('(pointer: coarse)');
  coarse?.addEventListener?.('change', check);
  return () => {
    globalThis.removeEventListener('resize', check);
    coarse?.removeEventListener?.('change', check);
  };
}
