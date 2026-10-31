/** The Canvas2D adapter against a recording stand-in for the 2D context (no browser in tests). */

import { describe, expect, it } from 'vitest';
import type { Draw2d, Frame2d } from '../../core/index.js';
import { CanvasSurface2d, decodeImageBlob } from './render.js';
import type { CanvasLike, Context2d, DecodedImage, ImageDecoders } from './render.js';

type Call = [string, ...unknown[]];

function fakeCanvas(width: number, height: number): { canvas: CanvasLike; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (text: string) => ({ width: text.length * 10 });
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

const IMAGE = { width: 8, height: 8 } as unknown as DecodedImage;

function surface(options: { fail?: boolean } = {}): { s: CanvasSurface2d; calls: Call[]; scratches: Call[][]; urls: string[] } {
  const { canvas, calls } = fakeCanvas(200, 100);
  const scratches: Call[][] = [];
  const urls: string[] = [];
  const s = new CanvasSurface2d(canvas, {
    url: (path) => `/game/${path}`,
    decode: (url) => {
      urls.push(url);
      return options.fail === true ? Promise.reject(new Error('404')) : Promise.resolve(IMAGE);
    },
    scratch: (w, h) => {
      const fake = fakeCanvas(w, h);
      scratches.push(fake.calls);
      return fake.canvas;
    },
  });
  return { s, calls, scratches, urls };
}

function frame(commands: Draw2d[], view: Partial<Frame2d['view']> = {}, lighting: Frame2d['lighting'] = null): Frame2d {
  return { frame: 1, view: { center: [0, 0], halfHeight: 5, angle: 0, background: null, viewport: [0, 0, 1, 1], ...view }, commands, lighting };
}

const named = (calls: Call[], name: string): Call[] => calls.filter((c) => c[0] === name);
const closeTo = (actual: unknown[], expected: number[]): void => expected.forEach((v, i) => expect(actual[i] as number).toBeCloseTo(v, 9));

describe('CanvasSurface2d lighting', () => {
  it('draws the light map offscreen (ambient, then each light added) and multiplies it over the scene', () => {
    const { s, calls, scratches } = surface();
    s.draw(frame([], {}, {
      ambient: [0.2, 0.2, 0.25],
      lights: [
        { kind: 'point', x: 2, y: 1, color: [1, 0.5, 0], intensity: 1, radius: 3, direction: 0, cone: 360, entity: 1 },
        { kind: 'spot', x: 0, y: 0, color: [0, 0, 1], intensity: 2, radius: 2, direction: 90, cone: 60, entity: 2 },
      ],
    }));
    const map = scratches.at(-1)!;
    expect(map).toContainEqual(['=fillStyle', 'rgb(51, 51, 64)']);
    expect(map).toContainEqual(['=globalCompositeOperation', 'lighter']);
    // The point light at (2, 1) m → (120, 40) px, 3 m → 30 px.
    expect(named(map, 'createRadialGradient')[0]).toEqual(['createRadialGradient', 120, 40, 0, 120, 40, 30]);
    expect(named(map, 'addColorStop')[0]).toEqual(['addColorStop', 0, 'rgb(255, 128, 0)']);
    expect(named(map, 'addColorStop')[8]).toEqual(['addColorStop', 1, 'rgb(0, 0, 0)']);
    // The spot points up (+y): on screen, -90° ± 30°.
    const arc = named(map, 'arc')[1]!;
    expect(arc[4] as number).toBeCloseTo(-Math.PI / 2 - Math.PI / 6, 9);
    expect(arc[5] as number).toBeCloseTo(-Math.PI / 2 + Math.PI / 6, 9);
    expect(calls).toContainEqual(['=globalCompositeOperation', 'multiply']);
    expect(named(calls, 'drawImage')).toHaveLength(1);
  });

  it('draws no light map without lighting', () => {
    const { s, calls } = surface();
    s.draw(frame([]));
    expect(calls).not.toContainEqual(['=globalCompositeOperation', 'multiply']);
  });
});

describe('CanvasSurface2d', () => {
  it('maps world meters (+y up) through the view onto the viewport', () => {
    const { s, calls } = surface();
    s.draw(frame([{ kind: 'rect', z: 0, entity: 1, transform: [1, 0, 0, 1, 2, 1], size: [2, 1], fill: [1, 0, 0, 1] }],
      { background: [0, 0, 0, 1], viewport: [0.5, 0, 0.5, 1] }));
    expect(named(calls, 'clearRect')).toEqual([['clearRect', 0, 0, 200, 100]]);
    expect(named(calls, 'rect')).toEqual([['rect', 100, 0, 100, 100]]);
    expect(named(calls, 'fillRect')[0]).toEqual(['fillRect', 100, 0, 100, 100]);
    // 100 px tall viewport / 10 m → 10 px per meter, centered at (150, 50), y flipped.
    const set = named(calls, 'setTransform').at(-1)!.slice(1);
    closeTo(set, [10, 0, 0, -10, 170, 40]);
    expect(named(calls, 'fillRect')[1]).toEqual(['fillRect', -1, -0.5, 2, 1]);
    expect(calls).toContainEqual(['=fillStyle', 'rgba(255, 0, 0, 1)']);
  });

  it('draws rounded rects, rings and polygons with outlines', () => {
    const { s, calls } = surface();
    const stroke = { width: 0.1, color: [1, 0, 0, 1] as const };
    s.draw(frame([
      { kind: 'rect', z: 0, entity: 1, transform: [1, 0, 0, 1, 0, 0], size: [2, 1], fill: [1, 1, 1, 1], radius: 0.25, stroke },
      { kind: 'ellipse', z: 0, entity: 2, transform: [1, 0, 0, 1, 0, 0], size: [2, 2], fill: [1, 1, 1, 1], image: null, hole: [1, 1] },
      { kind: 'polygon', z: 0, entity: 3, transform: [1, 0, 0, 1, 0, 0], points: [-1, 0, 1, 0, 0, 2], fill: [0, 1, 0, 1], stroke },
    ]));
    expect(named(calls, 'roundRect')).toEqual([['roundRect', -1, -0.5, 2, 1, 0.25]]);
    expect(named(calls, 'ellipse')).toEqual([['ellipse', 0, 0, 1, 1, 0, 0, Math.PI * 2], ['ellipse', 0, 0, 0.5, 0.5, 0, 0, Math.PI * 2]]);
    expect(named(calls, 'fill')).toEqual([['fill'], ['fill', 'evenodd'], ['fill']]);
    expect(named(calls, 'lineTo')).toEqual([['lineTo', 1, 0], ['lineTo', 0, 2]]);
    expect(named(calls, 'closePath')).toHaveLength(1);
    expect(named(calls, 'stroke')).toHaveLength(2);
    expect(calls).toContainEqual(['=lineWidth', 0.1]);
    expect(calls).toContainEqual(['=strokeStyle', 'rgba(255, 0, 0, 1)']);
  });

  it('turns the world against the camera roll', () => {
    const { s, calls } = surface();
    s.draw(frame([{ kind: 'rect', z: 0, entity: 1, transform: [1, 0, 0, 1, 1, 0], size: [1, 1], fill: [1, 1, 1, 1] }], { angle: 90 }));
    // A point 1 m right of a camera rolled 90° appears 1 m below the center.
    closeTo(named(calls, 'setTransform').at(-1)!.slice(5), [100, 60]);
  });

  it('loads images asynchronously, skips them until decoded, then draws them upright', async () => {
    const { s, calls, urls } = surface();
    const sprite: Draw2d = {
      kind: 'image', z: 0, entity: 1, transform: [1, 0, 0, 1, 0, 0], image: 'assets/images/ship.png', size: [2, 2],
      tint: [1, 1, 1, 0.5], flipX: true, flipY: false,
    };
    s.draw(frame([sprite]));
    expect(named(calls, 'drawImage')).toEqual([]);
    expect(urls).toEqual(['/game/assets/images/ship.png']);
    await Promise.resolve();
    expect(s.ready('assets/images/ship.png')).toBe(true);
    s.draw(frame([sprite]));
    expect(named(calls, 'drawImage')).toEqual([['drawImage', IMAGE, -1, -1, 2, 2]]);
    // flip_x mirrors x; images are y-down, so the world's y flip is undone.
    closeTo(named(calls, 'setTransform').at(-1)!.slice(1), [-10, 0, 0, 10, 100, 50]);
    expect(calls).toContainEqual(['=globalAlpha', 0.5]);
  });

  it('tints an image once into a scratch canvas and reuses it', async () => {
    const { s, calls, scratches } = surface();
    s.load('assets/images/gem.png');
    await Promise.resolve();
    const gem: Draw2d = {
      kind: 'image', z: 0, entity: 1, transform: [1, 0, 0, 1, 0, 0], image: 'assets/images/gem.png', size: [1, 1],
      tint: [1, 0, 0, 1], flipX: false, flipY: false,
    };
    s.draw(frame([gem]));
    s.draw(frame([gem]));
    expect(scratches).toHaveLength(1);
    expect(scratches[0]).toContainEqual(['=globalCompositeOperation', 'multiply']);
    expect(scratches[0]).toContainEqual(['=globalCompositeOperation', 'destination-in']);
    expect(named(calls, 'drawImage').every((c) => c[1] !== IMAGE)).toBe(true);
  });

  it('reports images that fail to load', async () => {
    const { s } = surface({ fail: true });
    s.load('assets/images/gone.png');
    await Promise.resolve();
    await Promise.resolve();
    expect(s.takeProblems().map((d) => [d.code, d.path])).toEqual([['PP3610', 'assets/images/gone.png']]);
    expect(s.takeProblems()).toEqual([]);
  });

  it('draws styled text spans, centered, line by line', () => {
    const { s, calls } = surface();
    s.draw(frame([{
      kind: 'text', z: 0, entity: 1, transform: [1, 0, 0, 1, 0, 0], size: 0.5,
      spans: [{ text: 'ab', color: [1, 1, 1, 1], bold: false }, { text: 'cd\nef', color: [1, 0, 0, 1], bold: true }],
    }]));
    const texts = named(calls, 'fillText').map((c) => [c[1], c[2], c[3]]);
    // 0.5 m at 64 units per meter = 32 px lines; 10 units per character in the stand-in.
    expect(texts).toEqual([['ab', -20, -16], ['cd', 0, -16], ['ef', -10, 16]]);
    expect(calls).toContainEqual(['=font', 'bold 32px system-ui, sans-serif']);
  });

  it('draws an additive image or rect with "lighter", then paints normally again', async () => {
    const { s, calls } = surface();
    const glow: Draw2d = { kind: 'image', z: 0, entity: 1, transform: [1, 0, 0, 1, 0, 0], image: 'a.png', size: [1, 1], tint: [1, 1, 1, 1], flipX: false, flipY: false, blend: 'additive' };
    s.load('a.png');
    await Promise.resolve();
    await Promise.resolve();
    s.draw(frame([glow, { kind: 'rect', z: 1, entity: 2, transform: [1, 0, 0, 1, 0, 0], size: [1, 1], fill: [1, 0, 0, 1] }]));
    const ops = calls.filter((c) => c[0] === '=globalCompositeOperation' || c[0] === 'drawImage' || c[0] === 'fillRect').map((c) => c[0] === 'drawImage' || c[0] === 'fillRect' ? c[0] : c[1]);
    expect(ops.slice(ops.indexOf('lighter'))).toEqual(['lighter', 'drawImage', 'source-over', 'fillRect']);
  });

  it('draws particles and lines', () => {
    const { s, calls } = surface();
    s.draw(frame([
      { kind: 'particles', z: 0, entity: null, shape: 'circle', image: null, count: 2, data: [0, 0, 0.2, 0, 1, 1, 1, 1, 1, 1, 0.4, 0, 1, 0, 0, 0.5] },
      { kind: 'particles', z: 0, entity: null, shape: 'square', image: null, count: 1, data: [0, 0, 0.5, 45, 1, 1, 1, 1] },
      { kind: 'line', z: 0, entity: null, points: [0, 0, 1, 0, 1, 1], width: 0.1, color: [0, 1, 0, 1] },
    ]));
    expect(named(calls, 'arc').map((c) => c[3])).toEqual([0.1, 0.2]);
    expect(named(calls, 'fillRect').at(-1)).toEqual(['fillRect', -0.25, -0.25, 0.5, 0.5]);
    expect(named(calls, 'lineTo')).toEqual([['lineTo', 1, 0], ['lineTo', 1, 1]]);
    expect(calls).toContainEqual(['=lineWidth', 0.1]);
    expect(named(calls, 'stroke')).toHaveLength(1);
  });
});

describe('decodeImageBlob', () => {
  function decoders(rasterizeSvg: boolean): ImageDecoders & { log: string[] } {
    const log: string[] = [];
    const element = { width: 32, height: 16, tag: 'img' } as unknown as DecodedImage;
    return {
      log,
      bitmap: async (source) => {
        if (source instanceof Blob) {
          if (source.type.startsWith('image/svg')) throw new Error('The source image could not be decoded.');
          log.push(`bitmap:${source.type}`);
        } else {
          if (!rasterizeSvg) throw new Error('no intrinsic size');
          log.push('bitmap:img');
        }
        return { width: 32, height: 16 } as unknown as DecodedImage;
      },
      element: async (blob) => {
        log.push(`element:${blob.type || 'untyped'}`);
        return { image: element, release: () => log.push('release') };
      },
    };
  }

  it('decodes rasters as bitmaps and SVG through an image element', async () => {
    const d = decoders(true);
    await decodeImageBlob(new Blob(['png'], { type: 'image/png' }), 'assets/images/a.png', d);
    const svg = await decodeImageBlob(new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'assets/images/b.svg', d);
    // A server that sends no content type: the file name decides.
    await decodeImageBlob(new Blob(['<svg/>']), 'assets/images/c.svg?v=2', d);
    expect(d.log).toEqual(['bitmap:image/png', 'element:image/svg+xml', 'bitmap:img', 'release', 'element:untyped', 'bitmap:img', 'release']);
    expect(svg.width).toBe(32);
  });

  it('keeps the image element when the browser cannot rasterize the SVG', async () => {
    const d = decoders(false);
    const img = await decodeImageBlob(new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'b.svg', d);
    expect((img as unknown as { tag: string }).tag).toBe('img');
    expect(d.log).toEqual(['element:image/svg+xml']);
  });
});
