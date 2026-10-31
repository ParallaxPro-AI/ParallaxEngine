/** The Canvas2D adapter's 2D post: bloom (threshold + blur offscreen, added back) and vignette, against recording contexts. */

import { describe, expect, it } from 'vitest';
import type { Frame2d, Post2d } from '../../core/index.js';
import { CanvasSurface2d, VIGNETTE_STOPS } from './render.js';
import type { CanvasLike, Context2d } from './render.js';

type Call = [string, ...unknown[]];

/** A recording 2D context; `filters` gives it a `filter` property as browsers with canvas filters do. */
function fakeCanvas(width: number, height: number, filters: boolean): { canvas: CanvasLike; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = filters ? { filter: 'none' } : {};
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'createRadialGradient') {
        return (...args: unknown[]) => {
          calls.push(['createRadialGradient', ...args]);
          return { addColorStop: (...stop: unknown[]) => calls.push(['addColorStop', ...stop]) };
        };
      }
      return (...args: unknown[]) => { calls.push([prop, ...args]); };
    },
    set(target, prop: string, value) {
      target[prop] = value;
      calls.push([`=${prop}`, value]);
      return true;
    },
  }) as unknown as Context2d;
  return { canvas: { width, height, getContext: () => ctx }, calls };
}

function surface(filters = true): { s: CanvasSurface2d; calls: Call[]; scratches: Array<{ w: number; h: number; calls: Call[] }> } {
  const { canvas, calls } = fakeCanvas(200, 100, true);
  const scratches: Array<{ w: number; h: number; calls: Call[] }> = [];
  const s = new CanvasSurface2d(canvas, {
    url: (path) => path,
    decode: () => Promise.reject(new Error('unused')),
    scratch: (w, h) => {
      const fake = fakeCanvas(w, h, filters);
      scratches.push({ w, h, calls: fake.calls });
      return fake.canvas;
    },
  });
  return { s, calls, scratches };
}

function frame(post: Post2d | null, lighting: Frame2d['lighting'] = null): Frame2d {
  return {
    frame: 1, view: { center: [0, 0], halfHeight: 5, angle: 0, background: [0, 0, 0, 1], viewport: [0, 0, 1, 1] }, commands: [], lighting,
    ...(post !== null && { post }),
  };
}

const named = (calls: Call[], name: string): Call[] => calls.filter((c) => c[0] === name);

describe('CanvasSurface2d post', () => {
  it('does nothing without post settings', () => {
    const { s, calls, scratches } = surface();
    s.draw(frame(null));
    expect(scratches).toHaveLength(0);
    expect(named(calls, 'createRadialGradient')).toEqual([]);
    expect(calls).not.toContainEqual(['=globalCompositeOperation', 'lighter']);
  });

  it('bloom: thresholds and blurs the viewport into a quarter-size canvas, then adds it back once per unit of strength', () => {
    const { s, calls, scratches } = surface();
    s.draw(frame({ bloom: 1.5, bloomThreshold: 0.6, vignette: 0 }));
    expect(scratches).toHaveLength(1);
    const glow = scratches[0]!;
    expect([glow.w, glow.h]).toEqual([50, 25]);
    // (c - 0.6) / 0.4 as brightness(1/1.6) then contrast(1.6/0.4); then the blur.
    const filter = glow.calls.find((c) => c[0] === '=filter' && c[1] !== 'none')![1] as string;
    expect(filter).toBe('brightness(0.6250) contrast(4.0000) blur(1.50px)');
    expect(named(glow.calls, 'drawImage')[0]!.slice(2)).toEqual([0, 0, 200, 100, 0, 0, 50, 25]);
    expect(glow.calls).toContainEqual(['=filter', 'none']);
    // Added over the viewport: a full pass, then half.
    const adds = calls.slice(calls.findIndex((c) => c[0] === '=globalCompositeOperation' && c[1] === 'lighter'));
    expect(named(adds, '=globalAlpha').map((c) => c[1])).toEqual([1, 0.5]);
    expect(named(adds, 'drawImage').map((c) => c.slice(2))).toEqual([[0, 0, 50, 25, 0, 0, 200, 100], [0, 0, 50, 25, 0, 0, 200, 100]]);
  });

  it('bloom runs after the light map (glows from the lit scene) and reuses its canvas', () => {
    const { s, calls, scratches } = surface();
    const lighting = { ambient: [0.2, 0.2, 0.2] as const, lights: [] };
    s.draw(frame({ bloom: 1, bloomThreshold: 0.5, vignette: 0 }, lighting));
    s.draw(frame({ bloom: 1, bloomThreshold: 0.5, vignette: 0 }, lighting));
    expect(scratches).toHaveLength(2); // the light map and the glow, each made once
    const ops = named(calls, '=globalCompositeOperation').map((c) => c[1]);
    expect(ops.indexOf('multiply')).toBeLessThan(ops.indexOf('lighter'));
  });

  it('skips bloom at a threshold of 1 or more, at zero strength, and without canvas filters', () => {
    for (const post of [{ bloom: 1, bloomThreshold: 1, vignette: 0 }, { bloom: 0, bloomThreshold: 0.5, vignette: 0 }]) {
      const { s, scratches } = surface();
      s.draw(frame(post));
      expect(scratches).toHaveLength(0);
    }
    const { s, calls } = surface(false);
    s.draw(frame({ bloom: 1, bloomThreshold: 0.5, vignette: 0 }));
    expect(calls).not.toContainEqual(['=globalCompositeOperation', 'lighter']);
  });

  it('vignette: a black radial gradient over the viewport\'s ellipse, smoothstep(0.35, 1) toward the corners', () => {
    const { s, calls } = surface();
    s.draw(frame({ bloom: 0, bloomThreshold: 1, vignette: 0.5 }));
    // The viewport as the square -1..1, a corner √2 from the center.
    expect(named(calls, 'setTransform').at(-1)).toEqual(['setTransform', 100, 0, 0, 50, 100, 50]);
    expect(named(calls, 'createRadialGradient')).toEqual([['createRadialGradient', 0, 0, 0, 0, 0, Math.SQRT2]]);
    const stops = named(calls, 'addColorStop');
    expect(stops).toHaveLength(VIGNETTE_STOPS.length);
    expect(stops[0]).toEqual(['addColorStop', 0, 'rgba(0, 0, 0, 0.0000)']);
    expect(stops[1]).toEqual(['addColorStop', 0.35, 'rgba(0, 0, 0, 0.0000)']);
    expect(stops.at(-1)).toEqual(['addColorStop', 1, 'rgba(0, 0, 0, 0.5000)']);
    expect(named(calls, 'fillRect').at(-1)).toEqual(['fillRect', -1, -1, 2, 2]);
  });
});
