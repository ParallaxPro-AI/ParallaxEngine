import { describe, expect, it, vi } from 'vitest';
import { cleanProjectName, MAX_PROJECT_NAME, renameProject } from './project_name.js';
import type { Editor } from './editor.js';

function target(title: string) {
  const state = { title, failures: [] as string[] };
  return {
    state,
    get title() { return state.title; },
    setTitle: (next: string) => { state.title = next; },
    fail: (what: string) => { state.failures.push(what); },
  };
}
const editor = {} as Editor;

describe('renaming the project', () => {
  it('takes a trimmed, changed, non-empty name of at most MAX_PROJECT_NAME characters', () => {
    expect(cleanProjectName('  Kart   Racer ', 'Kart')).toBe('Kart Racer');
    expect(cleanProjectName('Kart', 'Kart')).toBeNull();
    expect(cleanProjectName('   ', 'Kart')).toBeNull();
    expect(cleanProjectName(null, 'Kart')).toBeNull();
    expect(cleanProjectName('x'.repeat(500), 'Kart')).toHaveLength(MAX_PROJECT_NAME);
  });

  it("stores the name through the host's action, then shows it", async () => {
    const t = target('Kart');
    const action = vi.fn(async () => {});
    expect(await renameProject(t, ' Kart Racer ', action, editor)).toBe(true);
    expect(action).toHaveBeenCalledWith('Kart Racer', { editor, previous: 'Kart' });
    expect(t.state.title).toBe('Kart Racer');
  });

  it('keeps the old name and reports when the action fails; does nothing for a cancelled prompt', async () => {
    const t = target('Kart');
    const failing = vi.fn(async () => { throw new Error('HTTP 422'); });
    expect(await renameProject(t, 'Bad', failing, editor)).toBe(false);
    expect(t.state.title).toBe('Kart');
    expect(t.state.failures).toEqual(['Rename failed']);
    const never = vi.fn();
    expect(await renameProject(t, null, never, editor)).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });
});
