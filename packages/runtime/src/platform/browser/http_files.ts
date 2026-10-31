/**
 * A project's text files fetched over HTTP into memory, so the synchronous `ProjectFiles`
 * port can serve them. The server lists what it serves in an index (`{"files": [...]}`,
 * project-relative POSIX paths); text kinds the engine reads are fetched up front, binary
 * assets stay on the server for the renderers and audio to load by URL.
 */

import { fail } from '../../core/index.js';
import type { ProjectFiles } from '../../core/index.js';
import { InMemoryFiles } from '../headless/in_memory_files.js';

/** Files fetched before the game starts: data (JSON), dialogue scripts, and UI markup, styles and scripts. */
export const TEXT_FILE = /\.(json|yarn|plan|html|css|js)$/;

export interface FetchProjectOptions {
  /** URL of the file index. */
  readonly index: string;
  /** URL the project-relative paths resolve against (ends with "/"). */
  readonly base: string;
  readonly fetch?: (url: string) => Promise<Response>;
  /** Requests in flight at once. */
  readonly concurrency?: number;
}

async function get(fetchFn: (url: string) => Promise<Response>, url: string, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    return fail('PP9505', `Could not fetch ${what} (${url}): ${(error as Error).message}`, {
      fix: 'Check that `parallax edit` is still running, then reload.',
    });
  }
  if (!response.ok) {
    fail('PP9505', `Fetching ${what} (${url}) failed with HTTP ${response.status}`, {
      fix: 'Rebuild with `parallax build`, or restart `parallax edit`.',
    });
  }
  return response;
}

export interface FetchedProject {
  /** The text files, fetched. */
  readonly files: ProjectFiles;
  /** Every path the index lists, binary assets included. */
  readonly paths: readonly string[];
}

export async function fetchProjectFiles(options: FetchProjectOptions): Promise<FetchedProject> {
  const fetchFn = options.fetch ?? ((url: string) => globalThis.fetch(url));
  const index = (await (await get(fetchFn, options.index, 'the project file index')).json()) as { files?: unknown };
  if (!Array.isArray(index.files) || !index.files.every((f): f is string => typeof f === 'string')) {
    fail('PP9505', `The project file index (${options.index}) has no "files" list`, { fix: 'Restart `parallax edit`.' });
  }
  const paths = index.files.filter((p) => TEXT_FILE.test(p));
  const contents: Record<string, string> = {};
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const path = paths[next++]!;
      const url = new URL(path.split('/').map(encodeURIComponent).join('/'), options.base).href;
      contents[path] = await (await get(fetchFn, url, path)).text();
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 16, paths.length) }, worker));
  const all = [...index.files].sort();
  const text = new InMemoryFiles(contents);
  // Every served path is listed (renderers find their models and images by listing);
  // only the text kinds can be read here — binary assets load by URL.
  const files: ProjectFiles = {
    list: () => all,
    read: (path) => {
      if (TEXT_FILE.test(path)) return text.read(path);
      return fail('PP9526', `${path} is a binary asset; it is loaded by URL, not read as project text`, {
        fix: 'Load it through the renderer or audio (they fetch assets by URL).',
      });
    },
  };
  return { files, paths: all };
}
