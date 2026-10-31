import type { ProjectFiles } from '../../core/index.js';

/** A project held in memory: tests, and projects received as one bundle. */
export class InMemoryFiles implements ProjectFiles {
  readonly #files: ReadonlyMap<string, string>;

  constructor(files: Record<string, string>) {
    this.#files = new Map(Object.entries(files));
  }

  list(): readonly string[] {
    return [...this.#files.keys()].sort();
  }

  read(path: string): string {
    const text = this.#files.get(path);
    if (text === undefined) throw new Error(`No such project file: ${path}`);
    return text;
  }
}
