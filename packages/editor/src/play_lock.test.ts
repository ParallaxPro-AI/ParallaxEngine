import { describe, expect, it } from 'vitest';
import { capturesPress, lockChange, wantsPointerLock } from './play_lock.js';
import type { LockSituation } from './play_lock.js';

const PLAYING: LockSituation = { mode: 'playing', view: 'game', touch: false, gameLocks: true };
const MOUSE = { pointerType: 'mouse', button: 0 };

describe('play_lock', () => {
  it('locks every game while it plays on the Game tab on a desktop, unless it opts out', () => {
    expect(wantsPointerLock(PLAYING)).toBe(true); // chess, a platformer, an FPS alike
    expect(wantsPointerLock({ ...PLAYING, gameLocks: false })).toBe(false); // Game(pointer_lock=False)
    expect(wantsPointerLock({ ...PLAYING, view: 'scene' })).toBe(false);
    expect(wantsPointerLock({ ...PLAYING, mode: 'paused' })).toBe(false);
    expect(wantsPointerLock({ ...PLAYING, mode: 'edit' })).toBe(false);
    expect(wantsPointerLock({ ...PLAYING, touch: true })).toBe(false);
  });

  it('a left mouse press on an unlocked game view is the capture click; nothing else is', () => {
    expect(capturesPress(PLAYING, MOUSE, false)).toBe(true);
    expect(capturesPress(PLAYING, MOUSE, true)).toBe(false); // already locked: the press is the game's
    expect(capturesPress(PLAYING, { pointerType: 'mouse', button: 2 }, false)).toBe(false);
    expect(capturesPress(PLAYING, { pointerType: 'touch', button: 0 }, false)).toBe(false);
    expect(capturesPress({ ...PLAYING, gameLocks: false }, MOUSE, false)).toBe(false);
    expect(capturesPress({ ...PLAYING, view: 'scene' }, MOUSE, false)).toBe(false);
  });

  it('Play, Resume and the Game tab request the lock; Pause, Stop and the Scene tab free it', () => {
    const at = (mode: LockSituation['mode'], view: LockSituation['view'] = 'game', gameLocks = true): LockSituation => ({ mode, view, touch: false, gameLocks });
    expect(lockChange(at('edit'), at('playing'))).toBe('lock'); // Play
    expect(lockChange(at('paused'), at('playing'))).toBe('lock'); // Resume
    expect(lockChange(at('playing', 'scene'), at('playing', 'game'))).toBe('lock'); // the Game tab
    expect(lockChange(at('playing'), at('playing'))).toBe('keep'); // e.g. fullscreen: nothing changed
    expect(lockChange(at('playing'), at('playing', 'scene'))).toBe('release');
    expect(lockChange(at('playing'), at('paused'))).toBe('release');
    expect(lockChange(at('playing'), at('edit'))).toBe('release');
    // An opted-out game never locks on Play; a touch screen neither.
    expect(lockChange(at('edit'), at('playing', 'game', false))).toBe('keep');
    expect(lockChange(at('edit'), { ...at('playing'), touch: true })).toBe('keep');
  });
});
