import { describe, expect, it } from 'vitest';
import { documentTexts, settledPlay, swapFiles } from './play_settled.js';
import type { Editor } from './editor.js';

describe('Play of the settled version (play_settled.ts)', () => {
  it('swapFiles carries only what differs, and removes what the target lacks', () => {
    const from = new Map([['a.json', '1'], ['b.json', '2'], ['new.json', 'x']]);
    const to = new Map([['a.json', '1'], ['b.json', '3'], ['gone.json', 'y']]);
    expect(swapFiles(from, to)).toEqual(new Map<string, string | null>([['b.json', '3'], ['gone.json', 'y'], ['new.json', null]]));
    expect(swapFiles(to, to).size).toBe(0);
  });

  it('documentTexts keeps the text documents only (code comes with the build, binaries by URL)', () => {
    const docs = { list: () => ['game/main.py', 'scenes/main/scene.json', 'assets/images/a.png', 'story/a.yarn'], read: (p: string) => `<${p}>` };
    expect([...documentTexts(docs).keys()]).toEqual(['scenes/main/scene.json', 'story/a.yarn']);
  });

  function fakeEditor(files: Record<string, string>, reloadFails: () => boolean = () => false) {
    const texts = new Map(Object.entries(files));
    const reloads: string[] = [];
    let build = '';
    const editor = {
      documents: {
        list: () => [...texts.keys()],
        read: (p: string) => texts.get(p)!,
        replaceFiles: (m: ReadonlyMap<string, string | null>) => { for (const [p, t] of m) { if (t === null) texts.delete(p); else texts.set(p, t); } },
      },
      session: {
        history: { clear: () => {} },
        reload: async () => { reloads.push(build); if (reloadFails()) throw new Error('scene missing'); return { restored: true, diagnostics: [] }; },
      },
    } as unknown as Editor;
    return { editor, texts, reloads, setBuild: (url: string) => { build = url; } };
  }

  it('says what it loads: the last finished version on Play, back to the work in progress on Stop', async () => {
    const { editor, setBuild } = fakeEditor({ 'scenes/main/scene.json': 'half' });
    const labels: string[] = [];
    const swap = settledPlay(editor, { base: 'https://x.test/p/play/' }, {
      setBuild, ownBase: 'https://x.test/p/edit/', version: () => 1, stage: {} as HTMLElement,
      loading: (label) => { labels.push(label); return { done: () => {} }; },
      fetchTexts: async () => new Map([['scenes/main/scene.json', 'done']]),
    });
    await swap.enter();
    await swap.leave();
    expect(labels).toEqual(['Loading the last finished version…', 'Back to the work in progress…']);
  });

  it('enter swaps the settled files and build in; leave brings the editor\'s own back on the newest build', async () => {
    const own = { 'scenes/main/scene.json': 'half', 'prefabs/new.prefab.json': 'wip' };
    const { editor, texts, reloads, setBuild } = fakeEditor(own);
    let version = 7;
    const swap = settledPlay(editor, { base: 'https://x.test/p/play/' }, {
      setBuild, ownBase: 'https://x.test/p/edit/', version: () => version, stage: {} as HTMLElement, loading: () => ({ done: () => {} }),
      fetchTexts: async (base) => { expect(base.href).toBe('https://x.test/p/play/'); return new Map([['scenes/main/scene.json', 'done']]); },
    });
    expect(swap.label).toBe('Playing the last finished version of the project');
    await swap.enter();
    expect(Object.fromEntries(texts)).toEqual({ 'scenes/main/scene.json': 'done' });
    expect(reloads.at(-1)).toMatch(/^https:\/\/x\.test\/p\/play\/build\/v\d+\/$/);
    version = 9;
    await swap.leave();
    expect(Object.fromEntries(texts)).toEqual(own);
    // The editor's own build, under a number no runtime used yet.
    expect(reloads.at(-1)).toMatch(/^https:\/\/x\.test\/p\/edit\/build\/v\d+\/$/);
    expect(new Set(reloads).size).toBe(reloads.length);
  });

  it('a settled version that cannot load puts the editor\'s files back and says why', async () => {
    let fail = true;
    const { editor, texts, reloads, setBuild } = fakeEditor({ 'scenes/main/scene.json': 'half' }, () => { const f = fail; fail = false; return f; });
    const swap = settledPlay(editor, { base: 'https://x.test/p/play/', label: 'L' }, {
      setBuild, ownBase: 'https://x.test/p/edit/', version: () => 1, stage: {} as HTMLElement, loading: () => ({ done: () => {} }), fetchTexts: async () => new Map([['scenes/main/scene.json', 'done']]),
    });
    await expect(swap.enter()).rejects.toThrow('scene missing');
    expect(Object.fromEntries(texts)).toEqual({ 'scenes/main/scene.json': 'half' });
    expect(reloads.at(-1)).toMatch(/\/p\/edit\/build\/v\d+\/$/);
  });
});
