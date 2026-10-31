/**
 * A project directory on disk as the runtime's `ProjectFiles` port (data files), plus the
 * rest of the tree the checker needs: UI markup, story files and asset names.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { ProjectFiles } from '@parallax/runtime/core';

/** Never project input: generated output, dependencies, VCS and caches. */
const SKIPPED = new Set(['build', 'node_modules', '__pycache__', '.parallax', '.git']);

export interface ProjectTree extends ProjectFiles {
  readonly root: string;
  /** Every file in the project (POSIX paths relative to the root), sorted. */
  all(): readonly string[];
  exists(path: string): boolean;
  bytes(path: string): Uint8Array;
}

function walk(root: string, prefix: string, out: string[]): void {
  const dir = prefix === '' ? root : `${root}/${prefix}`;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name) || entry.name.startsWith('.')) continue;
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(root, path, out);
    else if (entry.isFile()) out.push(path);
  }
}

/** Data files the resource loader reads: JSON, `.yarn` dialogue and `.plan` floor plans outside playtests. */
function isDataFile(path: string): boolean {
  return (path.endsWith('.json') || path.endsWith('.yarn') || path.endsWith('.plan')) && !path.startsWith('tests/');
}

export function directoryFiles(root: string): ProjectTree {
  if (!existsSync(root)) throw new Error(`No project at ${root}`);
  const files: string[] = [];
  walk(root, '', files);
  files.sort();
  const known = new Set(files);
  return {
    root,
    all: () => files,
    list: () => files.filter(isDataFile),
    read: (path) => readFileSync(`${root}/${path}`, 'utf8'),
    exists: (path) => known.has(path),
    bytes: (path) => readFileSync(`${root}/${path}`),
  };
}

/** The same shape over an in-memory map (tests). */
export function memoryFiles(entries: Readonly<Record<string, string>>, root = '/memory'): ProjectTree {
  const files = Object.keys(entries).sort();
  return {
    root,
    all: () => files,
    list: () => files.filter(isDataFile),
    read: (path) => {
      const text = entries[path];
      if (text === undefined) throw new Error(`No file ${path}`);
      return text;
    },
    exists: (path) => path in entries,
    bytes: (path) => new TextEncoder().encode(entries[path] ?? ''),
  };
}
