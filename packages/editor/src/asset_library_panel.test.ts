import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addPiece, categoriesOf, displayName, fetchLibrary, filterPieces, LIBRARY_ADD_URL, nearEnd, PAGE_SIZE, pageOf, statusText } from './asset_library_panel.js';
import { buildLibraryModel, libraryModelUrl } from './asset_previews.js';
import type { LibraryPiece } from './asset_library_panel.js';

const piece = (id: string, category: string, summary = ''): LibraryPiece => ({ id, category, summary, added: false });

const PIECES = [
  piece('wooden_chair', 'models', 'A four-legged chair of planks.'),
  piece('adirondack_chair', 'models', 'Slatted outdoor lounge chair.'),
  piece('chair', 'models', 'A plain chair.'),
  piece('picnic_table', 'models', 'A table with bench seats, good for a park.'),
  piece('pause_menu', 'ui', 'Pause menu: Resume, Restart, Settings and Quit.'),
  piece('dash', 'movement', 'Dash / dodge roll with charges.'),
];

describe('asset library filtering', () => {
  it('lists everything, alphabetically, for an empty query', () => {
    expect(filterPieces(PIECES, '').map((p) => p.id)).toEqual(['adirondack_chair', 'chair', 'dash', 'pause_menu', 'picnic_table', 'wooden_chair']);
  });

  it('ranks an exact name, then a name prefix, then name words, then summary-only matches', () => {
    const ids = filterPieces(PIECES, 'chair').map((p) => p.id);
    expect(ids).toEqual(['chair', 'adirondack_chair', 'wooden_chair']);
    expect(filterPieces(PIECES, 'bench').map((p) => p.id)).toEqual(['picnic_table']);
    expect(filterPieces(PIECES, 'park table').map((p) => p.id)).toEqual(['picnic_table']);
  });

  it('treats underscores in the query as spaces and needs every word', () => {
    expect(filterPieces(PIECES, 'pause_menu').map((p) => p.id)).toEqual(['pause_menu']);
    expect(filterPieces(PIECES, 'chair outdoor').map((p) => p.id)).toEqual(['adirondack_chair']);
    expect(filterPieces(PIECES, 'zzz')).toEqual([]);
  });

  it('restricts to a category', () => {
    expect(filterPieces(PIECES, '', 'ui').map((p) => p.id)).toEqual(['pause_menu']);
    expect(filterPieces(PIECES, 'chair', 'ui')).toEqual([]);
  });

  it('counts categories with models first', () => {
    expect(categoriesOf(PIECES)).toEqual([{ category: 'models', count: 4 }, { category: 'movement', count: 1 }, { category: 'ui', count: 1 }]);
  });

  it('names a piece in words', () => {
    expect(displayName('ac_condenser_unit')).toBe('ac condenser unit');
  });
});

describe('asset library paging', () => {
  const items = Array.from({ length: 250 }, (_, i) => i);

  it('shows whole pages and says whether more remain', () => {
    expect(PAGE_SIZE).toBe(50);
    expect(pageOf(items, 1).shown).toEqual(items.slice(0, 50));
    expect(pageOf(items, 1).more).toBe(true);
    expect(pageOf(items, 2).shown).toHaveLength(100);
    expect(pageOf(items, 5)).toEqual({ shown: items, more: false });
    expect(pageOf(items, 9)).toEqual({ shown: items, more: false });
    expect(pageOf(items, 0, 10)).toEqual({ shown: [], more: true });
  });

  it('adds the next page when the list is scrolled near its end, or does not fill its box', () => {
    // 2000px of cards in a 300px panel.
    expect(nearEnd(0, 300, 2000)).toBe(false);
    expect(nearEnd(1400, 300, 2000)).toBe(false);
    expect(nearEnd(1460, 300, 2000)).toBe(true);
    expect(nearEnd(1700, 300, 2000)).toBe(true);
    // A first page shorter than the panel: no scrollbar to scroll, so more right away.
    expect(nearEnd(0, 300, 280)).toBe(true);
    expect(nearEnd(0, 300, 900, 0)).toBe(false);
  });

  it('describes what is shown', () => {
    expect(statusText(120, 2284, 2284)).toBe('Showing 120 · 2284 pieces');
    expect(statusText(3, 3, 2284)).toBe('3 matching of 2284');
    expect(statusText(0, 0, 2284)).toBe('No pieces match');
    expect(statusText(0, 0, 0)).toBe('The library is empty');
  });
});

describe('asset library server calls', () => {
  const reply = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it('reads the piece list', async () => {
    const pieces = await fetchLibrary(reply(200, { pieces: [{ id: 'chair', category: 'models', summary: 'A chair.', added: true }] }));
    expect(pieces).toEqual([{ id: 'chair', category: 'models', summary: 'A chair.', added: true }]);
  });

  it('posts the piece id and returns what was copied', async () => {
    let sent: { url: string; init: RequestInit | undefined } | undefined;
    const post = (async (url: string, init?: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ added: ['prefabs/chair.prefab.json'], prefab: 'chair' }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await addPiece('chair', post)).toEqual({ added: ['prefabs/chair.prefab.json'], prefab: 'chair' });
    expect(sent?.url).toBe(LIBRARY_ADD_URL);
    expect(sent?.init?.method).toBe('POST');
    expect(JSON.parse(String(sent?.init?.body))).toEqual({ piece: 'chair' });
  });

  it('throws the server error message on failure', async () => {
    await expect(addPiece('chair', reply(409, { error: 'prefabs/chair.prefab.json was changed here' }))).rejects.toThrow('prefabs/chair.prefab.json was changed here');
  });
});

describe('asset library thumbnails', () => {
  it('asks the editor server for a model piece\'s model document', () => {
    expect(libraryModelUrl('accordion')).toMatch(/\/__parallax__\/library-model\/accordion\.json$/);
  });

  it('builds a shipped library model document as the runtime builds a project model (what the portrait draws)', () => {
    const text = readFileSync(new URL('../../../shared_library/models/accordion/files/assets/models/accordion.model.json', import.meta.url), 'utf8');
    const model = buildLibraryModel('accordion', text);
    expect(model).not.toBeNull();
    expect(model!.meshes.some((primitives) => primitives.length > 0)).toBe(true);
    expect(buildLibraryModel('broken', '{ not json')).toBeNull();
    expect(buildLibraryModel('wrong', '{"format": "something else"}')).toBeNull();
  });
});
