import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../core/index.js';
import type { Frame2d } from '../../core/index.js';
import { RecordingSurface2d } from './render.js';

const view: Frame2d['view'] = { center: [0, 0], halfHeight: 5, angle: 0, background: null, viewport: [0, 0, 1, 1] };

function frame(n: number, kinds: Array<'rect' | 'line'>): Frame2d {
  return {
    frame: n,
    view,
    commands: kinds.map((kind) => (kind === 'rect'
      ? { kind, z: 0, entity: 1, transform: [1, 0, 0, 1, 0, 0], size: [1, 1], fill: [1, 1, 1, 1] }
      : { kind, z: 0, entity: null, points: [0, 0, 1, 1], width: 0.1, color: [1, 1, 1, 1] })),
    lighting: null,
  };
}

describe('RecordingSurface2d', () => {
  it('keeps the latest frames and counts commands by kind', () => {
    const surface = new RecordingSurface2d({ keep: 2, width: 640, height: 480 });
    expect(surface.size()).toEqual({ width: 640, height: 480 });
    for (let i = 1; i <= 3; i++) surface.draw(frame(i, i === 3 ? ['rect', 'rect', 'line'] : ['rect']));
    expect(surface.drawn).toBe(3);
    expect(surface.frames.map((f) => f.frame)).toEqual([2, 3]);
    expect(surface.counts()).toEqual({ rect: 2, line: 1 });
    expect(surface.counts(surface.frames[0])).toEqual({ rect: 1 });
  });

  it('records each image once and reports the ones told to fail', () => {
    const surface = new RecordingSurface2d({ failing: ['assets/images/broken.png'] });
    surface.load('assets/images/a.png');
    surface.load('assets/images/broken.png');
    surface.load('assets/images/a.png');
    expect(surface.loaded).toEqual(['assets/images/a.png', 'assets/images/broken.png']);
    expect(surface.takeProblems().map((d) => [d.code, d.path])).toEqual([['PP3610', 'assets/images/broken.png']]);
    expect(surface.takeProblems()).toEqual([]);
  });

  it('refuses to keep no frames', () => {
    expect(() => new RecordingSurface2d({ keep: 0 })).toThrow(ParallaxError);
  });
});
