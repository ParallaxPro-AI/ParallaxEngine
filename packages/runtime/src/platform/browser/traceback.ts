/**
 * Python tracebacks in the browser: an error's JavaScript stack, mapped to the project's
 * .py files and lines through the source maps the transpiler writes next to every module
 * (`<module>.js.map`, the .py line of each JS line). Only frames in the game's compiled
 * modules are kept, outermost call first, as Python prints them.
 *
 * The maps the page gets carry no `sourcesContent` (`parallax edit` strips it: Python source
 * never reaches the browser), so a frame names its file, line and function, not the code.
 * The same decoding as the test harness's traceback (`packages/test/src/traceback.ts`).
 */

/** One Python frame. */
export interface PyFrame {
  /** Project path of the .py file (`game/behaviors/paddle.py`). */
  readonly source: string;
  /** The .py line, or undefined when the map doesn't cover the compiled line. */
  readonly line: number | undefined;
  /** The function, as the stack names it (`update`, `Paddle.update`), or undefined at module level. */
  readonly name: string | undefined;
  /** The compiled module and line, for frames the map doesn't cover. */
  readonly compiled: string;
  readonly compiledLine: number;
}

export interface TraceSources {
  /** The build's URL (ending in `/`): compiled modules are `<build><output>`. */
  readonly build: string;
  /** Build output path → project source path (the manifest's modules). */
  readonly sources: Readonly<Record<string, string>>;
  /** A build file's text (`game/x.js.map`), or undefined when there is none. */
  readonly fetchText: (url: string) => Promise<string | undefined>;
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

/** V8 (`at fn (url:line:col)`, `at url:line:col`) and Firefox/Safari (`fn@url:line:col`) frames. */
const V8_FRAME = /^\s*at (?:(.+?) \()?((?:https?|file):\/\/[^\s)]+?):(\d+):(\d+)\)?\s*$/;
const GECKO_FRAME = /^\s*(.*?)@((?:https?|file):\/\/\S+?):(\d+):(\d+)\s*$/;

interface RawFrame {
  readonly name: string | undefined;
  readonly url: string;
  readonly line: number;
}

function rawFrames(stack: string): RawFrame[] {
  const out: RawFrame[] = [];
  for (const text of stack.split('\n')) {
    const m = V8_FRAME.exec(text) ?? GECKO_FRAME.exec(text);
    if (m === null) continue;
    const name = m[1] === undefined || m[1] === '' ? undefined : m[1].replace(/^(?:async |new )/, '').replace(/^Object\./, '');
    out.push({ name, url: m[2]!.replace(/[?#].*$/, ''), line: Number(m[3]) });
  }
  return out;
}

/** The game frames of `stack`, outermost first (Python's order). */
export async function pythonTraceback(stack: string, sources: TraceSources): Promise<PyFrame[]> {
  const tables = new Map<string, Promise<number[] | null>>();
  const table = (compiled: string): Promise<number[] | null> => {
    let found = tables.get(compiled);
    if (found === undefined) {
      found = sources.fetchText(`${sources.build}${compiled}.map`).then((text) => {
        if (text === undefined) return null;
        try {
          const map = JSON.parse(text) as { mappings?: unknown };
          return typeof map.mappings === 'string' ? decodeLines(map.mappings) : null;
        } catch {
          return null; // an unreadable map: the frame keeps its compiled line
        }
      });
      tables.set(compiled, found);
    }
    return found;
  };
  const frames: PyFrame[] = [];
  for (const raw of rawFrames(stack)) {
    if (!raw.url.startsWith(sources.build)) continue;
    const compiled = decodeURIComponent(raw.url.slice(sources.build.length));
    const source = sources.sources[compiled];
    if (source === undefined) continue;
    const lines = await table(compiled);
    const line = lines?.[raw.line - 1];
    frames.push({ source, line: line === undefined || line === 0 ? undefined : line, name: raw.name, compiled, compiledLine: raw.line });
  }
  return frames.reverse();
}

/** Python's layout: `File "game/x.py", line 12, in update`. */
export function formatTraceback(frames: readonly PyFrame[]): string[] {
  return frames.map((f) => {
    const where = f.line === undefined ? `File "${f.source}" (compiled ${f.compiled}:${f.compiledLine})` : `File "${f.source}", line ${f.line}`;
    return f.name === undefined ? where : `${where}, in ${f.name}`;
  });
}
