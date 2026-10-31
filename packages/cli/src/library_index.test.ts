/**
 * Search by meaning: the text each piece is embedded from, building and refreshing the index
 * (only changed pieces are embedded again), and the ranking. A word-count "model" stands in
 * for the real one, so nothing is downloaded.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLibrary } from './library.js';
import { buildIndex, indexStatus, pieceText, rankByMeaning, readIndex } from './library_index.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(`${root}/${path}`), { recursive: true });
    writeFileSync(`${root}/${path}`, text);
  }
}

function model(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ format: 'parallax.model', version: 1, materials: {}, meshes: {}, parts: [], ...extra });
}

function piece(id: string, summary: string, modelDoc?: string): Record<string, string> {
  return {
    [`models/${id}/piece.json`]: JSON.stringify({ id, summary, version: '2026.10.23' }),
    [`models/${id}/files/assets/models/${id}.model.json`]: modelDoc ?? model(),
  };
}

/** A library of a person (by skeleton only), a board with stand sockets and a tree. */
function fixture(): string {
  const root = mkdtempSync(`${tmpdir()}/parallax-index-`);
  made.push(root);
  write(root, {
    ...piece('townsfolk', 'Someone in a coat.', model({ skeleton: { bones: Array.from({ length: 17 }, (_, i) => ({ name: `b${i}` })) }, options: [{ name: 'jacket' }] })),
    ...piece('board', 'A board.', model({ sockets: [{ name: 'stand_front' }, { name: 'stand_rear' }] })),
    ...piece('tree_pine', 'A tall conifer.', model({ parts: [{ name: 'crown_needles_merged' }] })),
  });
  return root;
}

/** A bag-of-words embedding: one dimension per word, so texts sharing words are close. */
const VOCAB = ['person', 'human', 'rideable', 'rider', 'conifer', 'needles', 'board', 'coat', 'tree', 'jacket'];
let calls: string[][] = [];
async function embed(texts: string[]): Promise<Float32Array[]> {
  calls.push(texts);
  return texts.map((t) => {
    const v = new Float32Array(VOCAB.length);
    for (const w of t.toLowerCase().split(/[^a-z]+/)) { const i = VOCAB.indexOf(w); if (i >= 0) v[i] = v[i]! + 1; }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
}

describe('library search by meaning', () => {
  it('describes a piece by what its model implies: a skeleton is a person, stand sockets are rideable', () => {
    const library = loadLibrary(fixture());
    expect(pieceText(library.pieces.get('townsfolk')!)).toMatch(/person, human/);
    expect(pieceText(library.pieces.get('townsfolk')!)).toContain('jacket');
    expect(pieceText(library.pieces.get('board')!)).toContain('rideable');
    expect(pieceText(library.pieces.get('tree_pine')!)).toContain('needles');
  });

  it('ranks by meaning, so "person" finds a piece whose name and summary never say it', async () => {
    const library = loadLibrary(fixture());
    calls = [];
    const { index } = await buildIndex(library, embed);
    const query = (await embed(['person']))[0]!;
    expect(rankByMeaning(library, index, query, 'person')[0]?.id).toBe('townsfolk');
    expect(rankByMeaning(library, index, (await embed(['conifer needles']))[0]!, 'conifer needles', { limit: 1 }).map((p) => p.id)).toEqual(['tree_pine']);
  });

  it('keeps the index on disk and embeds again only the pieces that changed', async () => {
    const root = fixture();
    let library = loadLibrary(root);
    calls = [];
    await buildIndex(library, embed);
    expect(calls.flat()).toHaveLength(3);
    const index = readIndex(root)!;
    expect(indexStatus(library, index)).toEqual({ stale: [], restamp: false });

    write(root, piece('board', 'A snowboard with bindings.', model({ sockets: [{ name: 'stand_front' }] })));
    write(root, piece('sled', 'A wooden sled.'));
    library = loadLibrary(root);
    expect(indexStatus(library, index).stale.sort()).toEqual(['board', 'sled']);
    calls = [];
    const { index: next, embedded } = await buildIndex(library, embed, index);
    expect(embedded).toBe(2);
    expect(calls.flat().map((t) => t.split('.')[0])).toEqual(['board', 'sled']);
    expect(next.ids).toEqual(['board', 'sled', 'townsfolk', 'tree_pine']);
    expect(indexStatus(library, readIndex(root)!)).toEqual({ stale: [], restamp: false });
  });

  it('reports a removed piece as stale, and an older index file as missing', async () => {
    const root = fixture();
    await buildIndex(loadLibrary(root), embed);
    rmSync(`${root}/models/board`, { recursive: true });
    expect(indexStatus(loadLibrary(root), readIndex(root)!).stale).toEqual(['board']);
    writeFileSync(`${root}/_index/index.json`, JSON.stringify({ model: 'x', dims: 1, ids: [], hashes: [] }));
    expect(readIndex(root)).toBeUndefined();
  });
});
