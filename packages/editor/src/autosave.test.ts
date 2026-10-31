import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Autosave, AUTOSAVE_MS, AUTOSAVE_RETRY_MS, autosaveVerdict } from './autosave.js';
import type { AutosaveState } from './autosave.js';

const idle: AutosaveState = { dirty: true, playing: false, dragging: false, saving: false };

describe('autosaveVerdict', () => {
  it('saves only unsaved edits, outside play, drags and other saves', () => {
    expect(autosaveVerdict(idle)).toBe('save');
    expect(autosaveVerdict({ ...idle, dirty: false })).toBe('clean');
    expect(autosaveVerdict({ ...idle, playing: true })).toBe('playing');
    expect(autosaveVerdict({ ...idle, dragging: true })).toBe('busy');
    expect(autosaveVerdict({ ...idle, saving: true })).toBe('busy');
    expect(autosaveVerdict({ ...idle, dirty: false, dragging: true })).toBe('clean');
  });
});

describe('Autosave timer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(initial: Partial<AutosaveState> = {}): { state: { current: AutosaveState }; save: ReturnType<typeof vi.fn>; autosave: Autosave } {
    const state = { current: { ...idle, ...initial } };
    const save = vi.fn(() => { state.current = { ...state.current, dirty: false }; });
    const autosave = new Autosave({ state: () => state.current, save });
    autosave.start();
    return { state, save, autosave };
  }

  it('saves every 30 s while there are unsaved edits, and not before', () => {
    const { state, save, autosave } = setup();
    vi.advanceTimersByTime(AUTOSAVE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(AUTOSAVE_MS);
    expect(save).toHaveBeenCalledTimes(1); // clean now
    state.current = { ...state.current, dirty: true };
    vi.advanceTimersByTime(AUTOSAVE_MS);
    expect(save).toHaveBeenCalledTimes(2);
    autosave.stop();
    state.current = { ...state.current, dirty: true };
    vi.advanceTimersByTime(AUTOSAVE_MS * 3);
    expect(save).toHaveBeenCalledTimes(2);
    expect(autosave.running).toBe(false);
  });

  it('skips ticks while playing and saves on the first tick after Stop', () => {
    const { state, save } = setup({ playing: true });
    vi.advanceTimersByTime(AUTOSAVE_MS * 2);
    expect(save).not.toHaveBeenCalled();
    state.current = { ...state.current, playing: false };
    vi.advanceTimersByTime(AUTOSAVE_RETRY_MS);
    expect(save).not.toHaveBeenCalled(); // waits for the next tick, no fast retry
    vi.advanceTimersByTime(AUTOSAVE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('a tick during a drag tries again shortly after the drag ends', () => {
    const { state, save } = setup({ dragging: true });
    vi.advanceTimersByTime(AUTOSAVE_MS);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AUTOSAVE_RETRY_MS * 3);
    expect(save).not.toHaveBeenCalled();
    state.current = { ...state.current, dragging: false };
    vi.advanceTimersByTime(AUTOSAVE_RETRY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('never overlaps a save in progress', () => {
    const { state, save } = setup({ saving: true });
    vi.advanceTimersByTime(AUTOSAVE_MS);
    expect(save).not.toHaveBeenCalled();
    state.current = { ...state.current, saving: false };
    vi.advanceTimersByTime(AUTOSAVE_RETRY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('a failed save does not stop the timer', async () => {
    const state = { current: idle };
    const save = vi.fn(() => Promise.reject(new Error('offline')));
    const autosave = new Autosave({ state: () => state.current, save });
    autosave.start();
    vi.advanceTimersByTime(AUTOSAVE_MS);
    await Promise.resolve();
    vi.advanceTimersByTime(AUTOSAVE_MS);
    expect(save).toHaveBeenCalledTimes(2);
    autosave.stop();
  });
});
