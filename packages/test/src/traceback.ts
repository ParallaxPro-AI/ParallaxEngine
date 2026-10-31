/**
 * Python-side tracebacks from V8 stacks: keep the frames in the project's modules, name
 * each by its .py source and line, and quote the .py line (from the source map's
 * `sourcesContent`). The transpiler writes a standard source map next to every module
 * (`<module>.js.map`, one segment per mapped JS line), so a frame arrives either way:
 *
 *   - already mapped, when the process runs with source maps on (the playtest child does,
 *     `--enable-source-maps`): V8 names the .py file under the project directory;
 *   - compiled (`<build>/<module>.js:<line>`): mapped here through the same map.
 *
 * A compiled frame the map doesn't cover (imports, hoisted constants) keeps the compiled
 * line and quotes it.
 */

import type { TraceFrame } from './results.js';

/** `at fn (where:line:col)` or `at where:line:col`; `where` is a file:/node: URL or an absolute path. */
const FRAME = /^\s*at (?:.*? \()?((?:file:|node:|\/)[^)]*?):(\d+):(\d+)\)?\s*$/;

export interface TraceContext {
  /** The build directory as a file URL ending in `/`. */
  readonly build: string;
  /** Build output path → project source path. */
  readonly sources: Readonly<Record<string, string>>;
  /** The project directory as an absolute path ending in `/` (where source-mapped frames point). */
  readonly project: string;
  /** A file of the build (a compiled module, or its `.js.map`), for mapping and quoting lines. */
  readonly read: (output: string) => string | undefined;
}

/** What a module's source map says: the .py line of each JS line (0 = unmapped), and the .py text. */
interface LineTable {
  readonly lines: readonly number[];
  readonly source: readonly string[] | undefined;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * The 1-based source line of the first segment of each generated line (0 = none), from a
 * v3 `mappings` string. Only the first source is read: the transpiler maps one .py per module.
 */
export function decodeLines(mappings: string): number[] {
  const out: number[] = [];
  let sourceLine = 0;
  for (const group of mappings.split(';')) {
    let first: number | undefined;
    for (const segment of group === '' ? [] : group.split(',')) {
      const values: number[] = [];
      let shift = 0;
      let n = 0;
      for (const ch of segment) {
        const digit = B64.indexOf(ch);
        if (digit < 0) return out; // not a valid map: stop where it breaks
        n += (digit & 31) * 2 ** shift;
        shift += 5;
        if ((digit & 32) === 0) {
          values.push(n % 2 === 1 ? -Math.floor(n / 2) : Math.floor(n / 2));
          shift = 0;
          n = 0;
        }
      }
      if (values.length >= 4) {
        sourceLine += values[2]!;
        first ??= sourceLine + 1;
      }
    }
    out.push(first ?? 0);
  }
  return out;
}

const tables = new WeakMap<TraceContext, Map<string, LineTable | null>>();

function tableOf(compiled: string, context: TraceContext): LineTable | null {
  let cache = tables.get(context);
  if (cache === undefined) tables.set(context, (cache = new Map()));
  if (!cache.has(compiled)) {
    let table: LineTable | null = null;
    const text = context.read(`${compiled}.map`);
    if (text !== undefined) {
      try {
        const map = JSON.parse(text) as { mappings?: unknown; sourcesContent?: unknown };
        if (typeof map.mappings === 'string') {
          const content = Array.isArray(map.sourcesContent) && typeof map.sourcesContent[0] === 'string'
            ? map.sourcesContent[0].split('\n')
            : undefined;
          table = { lines: decodeLines(map.mappings), source: content };
        }
      } catch {
        table = null; // an unreadable map: fall back to compiled lines
      }
    }
    cache.set(compiled, table);
  }
  return cache.get(compiled)!;
}

/** A source-mapped frame: `where` is a project .py file; `line` is already its line. */
function mappedFrame(where: string, line: number, column: number, context: TraceContext): TraceFrame | undefined {
  const path = where.startsWith('file:') ? decodeURIComponent(new URL(where).pathname) : where;
  if (!path.startsWith(context.project)) return undefined;
  const source = path.slice(context.project.length);
  const compiled = Object.keys(context.sources).find((output) => context.sources[output] === source);
  if (compiled === undefined) return undefined;
  const code = tableOf(compiled, context)?.source?.[line - 1]?.trim();
  return { source, line, compiled, column, ...(code !== undefined && { code }) };
}

/** The project frames of one stack, innermost first (V8 order). */
export function projectFrames(stack: string, context: TraceContext): TraceFrame[] {
  const out: TraceFrame[] = [];
  for (const line of stack.split('\n')) {
    const m = FRAME.exec(line);
    if (m === null) continue;
    const url = m[1]!.replace(/\?[^#]*$/, '');
    const compiledLine = Number(m[2]);
    const column = Number(m[3]);
    if (!url.startsWith(context.build)) {
      const mapped = mappedFrame(url, compiledLine, column, context);
      if (mapped !== undefined) out.push(mapped);
      continue;
    }
    const compiled = decodeURIComponent(url.slice(context.build.length));
    const source = context.sources[compiled];
    if (source === undefined) continue;
    const pyLine = tableOf(compiled, context)?.lines[compiledLine - 1] ?? 0;
    if (pyLine > 0) {
      const code = tableOf(compiled, context)?.source?.[pyLine - 1]?.trim();
      out.push({ source, line: pyLine, compiled, compiledLine, column, ...(code !== undefined && { code }) });
    } else {
      const code = context.read(compiled)?.split('\n')[compiledLine - 1]?.trim();
      out.push({ source, compiled, compiledLine, column, ...(code !== undefined && { code }) });
    }
  }
  return out;
}

/**
 * The traceback of an error, outermost call first: the frames where the test called the
 * harness (when the harness raised for it), then the error's own project frames.
 */
export function traceback(stack: string, site: string | undefined, context: TraceContext): TraceFrame[] {
  const own = projectFrames(stack, context).reverse();
  if (site === undefined) return own;
  const calls = projectFrames(site, context).reverse();
  return [...calls, ...own];
}

export function formatFrames(frames: readonly TraceFrame[], indent = '  '): string[] {
  const lines: string[] = [];
  for (const f of frames) {
    lines.push(f.line === undefined
      ? `${indent}${f.source} (compiled ${f.compiled}:${String(f.compiledLine)})`
      : `${indent}${f.source}:${f.line}`);
    if (f.code !== undefined) lines.push(`${indent}  ${f.code}`);
  }
  return lines;
}
