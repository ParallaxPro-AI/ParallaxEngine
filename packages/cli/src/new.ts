/**
 * `parallax new <dir> [--template NAME | --example NAME] [--name TITLE]` and `parallax new --list`:
 * start a project from one of the templates in `packages/cli/templates/<name>/`, or from a
 * copy of a complete game in `examples/<name>/`.
 *
 * A template is a real project folder. Copying it changes exactly two things:
 *   - `{{title}}` and `{{id}}` in file contents become the game's title and id;
 *   - a file named `gitignore` is written as `.gitignore` (package managers drop
 *     dot-files named `.gitignore` when they pack a package).
 * Nothing else is rewritten. Each template passes `parallax check` and `parallax test`.
 *
 * An example is copied as it is, without its generated output, and only the `id` and
 * `title` in its `Game(...)` change.
 *
 * Exit codes: 0 created, 1 the target folder is in use, 2 bad usage.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** `packages/cli/templates/`: one folder per template. */
export const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

/** The templates, in the order `--list` shows them; the first is the default. */
export const TEMPLATES: Readonly<Record<string, string>> = {
  'blank-2d': 'one 2D scene and a square you move with WASD/arrows/stick/touch, with playtests',
  'blank-3d': 'a 3D scene (camera, light, ground) and a box you move over the ground, with playtests',
  'arcade-2d': 'dodge falling rocks: score HUD, game over card, Retry and a kept best score',
};

export const DEFAULT_TEMPLATE = 'blank-2d';

/** `examples/`: one complete game per folder. */
export const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples/', import.meta.url));

/** The examples, by folder name, with the title each one's `game/main.py` gives it. */
export function listExamples(dir: string = EXAMPLES_DIR): { name: string; title: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${dir}/${e.name}/game/main.py`))
    .map((e) => ({ name: e.name, title: /\btitle\s*=\s*"([^"]*)"/.exec(readFileSync(`${dir}/${e.name}/game/main.py`, 'utf8'))?.[1] ?? e.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const NEW_USAGE = `Usage:
  parallax new <dir> [--template NAME | --example NAME] [--name TITLE]
  parallax new --list
`;

/** Folders a template may have picked up from being checked or tested in place. */
const SKIPPED = new Set(['build', '.parallax', '__pycache__']);

/** Generated folders an example may have from being checked or tested in place. */
const EXAMPLE_SKIPPED = new Set(['build', '__pycache__', 'node_modules']);

/** Template files written under another name. */
const RENAMED: Readonly<Record<string, string>> = { gitignore: '.gitignore' };

export interface NewArgs {
  readonly dir: string;
  readonly template: string;
  readonly example?: string;
  readonly title?: string;
}

export function newArgs(argv: readonly string[]): NewArgs | 'list' | string {
  let dir: string | undefined;
  let template = DEFAULT_TEMPLATE;
  let example: string | undefined;
  let chosenTemplate = false;
  let title: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--list') {
      if (argv.length > 1) return '--list takes no other arguments';
      return 'list';
    }
    if (arg === '--template' || arg === '--example' || arg === '--name') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return `${arg} needs a value`;
      if (arg === '--template') { template = v; chosenTemplate = true; } else if (arg === '--example') example = v; else title = v;
    } else if (arg.startsWith('-')) return `Unknown option ${arg}`;
    else if (dir === undefined) dir = arg;
    else return `Unexpected argument ${arg}`;
  }
  if (dir === undefined) return 'new needs the folder to create';
  if (example !== undefined && chosenTemplate) return '--template and --example are exclusive';
  return { dir, template, ...(example !== undefined && { example }), ...(title !== undefined && { title }) };
}

/** A Python/JSON-safe game id from a folder name: `My Game-2` → `my_game_2`. */
export function gameId(folder: string): string {
  const id = folder.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (id === '') return 'game';
  return /^[0-9]/.test(id) ? `game_${id}` : id;
}

/** A title from a folder name: `my_game` → `My Game`. */
export function titleFrom(folder: string): string {
  const words = folder.split(/[^A-Za-z0-9]+/).filter((w) => w !== '');
  return words.length === 0 ? 'My Game' : words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Why a title can't go into the template's Python and JSON strings as written, or
 * undefined. (Quotes and backslashes would need escaping; braces are locale placeholders.)
 */
export function badTitle(title: string): string | undefined {
  if (title.trim() === '') return '--name needs a non-empty title';
  if (/["\\{}\u0000-\u001f\u007f]/.test(title)) return '--name cannot contain quotes, backslashes, braces or control characters';
  return undefined;
}

export function formatTemplates(): string {
  const width = Math.max(...Object.keys(TEMPLATES).map((n) => n.length));
  return Object.entries(TEMPLATES)
    .map(([name, about]) => `  ${name.padEnd(width)}  ${about}${name === DEFAULT_TEMPLATE ? ' (default)' : ''}`)
    .join('\n');
}

function isEmptyOrMissing(dir: string): boolean | 'file' {
  if (!existsSync(dir)) return true;
  if (!statSync(dir).isDirectory()) return 'file';
  return readdirSync(dir, { withFileTypes: true }).length === 0;
}

/** Copies one template into `target` (which must not exist or be empty); returns the files written. */
export function createProject(target: string, template: string, values: { readonly id: string; readonly title: string }): string[] {
  const written: string[] = [];
  const copy = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    const entries = readdirSync(from, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue;
      if (entry.isDirectory()) { copy(`${from}/${entry.name}`, `${to}/${entry.name}`); continue; }
      if (!entry.isFile()) continue;
      const text = readFileSync(`${from}/${entry.name}`, 'utf8')
        .replaceAll('{{title}}', values.title)
        .replaceAll('{{id}}', values.id);
      const out = `${to}/${RENAMED[entry.name] ?? entry.name}`;
      writeFileSync(out, text);
      written.push(relative(target, out));
    }
  };
  copy(`${TEMPLATES_DIR}${template}`, target);
  return written;
}

/** Copies `examples/<name>` into `target` with the game's new id and title; returns the files written. */
export function createFromExample(target: string, name: string, values: { readonly id: string; readonly title: string }, dir: string = EXAMPLES_DIR): string[] {
  const written: string[] = [];
  const copy = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    const entries = readdirSync(from, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (EXAMPLE_SKIPPED.has(entry.name)) continue;
      if (entry.isDirectory()) { copy(`${from}/${entry.name}`, `${to}/${entry.name}`); continue; }
      if (!entry.isFile()) continue;
      writeFileSync(`${to}/${entry.name}`, readFileSync(`${from}/${entry.name}`));
      written.push(relative(target, `${to}/${entry.name}`));
    }
  };
  copy(`${dir}${name}`, target);
  // Only the Game(...) call's own id and title: the first of each after `Game(`.
  const main = `${target}/game/main.py`;
  const source = readFileSync(main, 'utf8');
  const at = source.search(/\bGame\(/);
  if (at >= 0) {
    const head = source.slice(0, at);
    const call = source.slice(at)
      .replace(/(\bid\s*=\s*)"[^"]*"/, (_, key: string) => `${key}"${values.id}"`)
      .replace(/(\btitle\s*=\s*)"[^"]*"/, (_, key: string) => `${key}"${values.title}"`);
    writeFileSync(main, head + call);
  }
  return written;
}

/** The target as the next-step commands should spell it: relative when inside the cwd, quoted if needed. */
function shellPath(target: string): string {
  const rel = relative(process.cwd(), target);
  const path = rel === '' ? '.' : rel.startsWith('..') ? target : rel;
  return /^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

export function newMain(argv: readonly string[]): number {
  const usage = (message?: string): number => {
    process.stderr.write(`${message !== undefined ? `${message}\n\n` : ''}${NEW_USAGE}`);
    return 2;
  };
  const args = newArgs(argv);
  if (args === 'list') {
    const examples = listExamples();
    const width = Math.max(0, ...examples.map((e) => e.name.length));
    process.stdout.write(`Templates:\n${formatTemplates()}\n\nExamples (complete games; start from one with --example NAME):\n${examples.map((e) => `  ${e.name.padEnd(width)}  ${e.title}`).join('\n')}\n`);
    return 0;
  }
  if (typeof args === 'string') return usage(args);
  if (args.example !== undefined && !listExamples().some((e) => e.name === args.example)) {
    process.stderr.write(`Unknown example "${args.example}". Examples: ${listExamples().map((e) => e.name).join(', ')}\n`);
    return 2;
  }
  if (args.example === undefined && !Object.hasOwn(TEMPLATES, args.template)) {
    process.stderr.write(`Unknown template "${args.template}". Templates:\n${formatTemplates()}\n`);
    return 2;
  }
  const target = resolve(args.dir);
  const title = args.title ?? titleFrom(basename(target));
  const problem = badTitle(title);
  if (problem !== undefined) return usage(problem);

  const free = isEmptyOrMissing(target);
  if (free !== true) {
    process.stderr.write(free === 'file'
      ? `${args.dir} is a file, not a folder. Pick a new folder for the project.\n`
      : `${args.dir} is not empty. Pick a new or empty folder; parallax new never overwrites files.\n`);
    return 1;
  }

  const values = { id: gameId(basename(target)), title };
  const files = args.example !== undefined ? createFromExample(target, args.example, values) : createProject(target, args.template, values);
  const shown = shellPath(target);
  const source = args.example !== undefined ? `the ${args.example} example` : `the ${args.template} template`;
  process.stdout.write(`Created "${title}" in ${shown} from ${source} (${files.length} files).
${args.example !== undefined ? `
This is the whole ${args.example} game. Keep the systems, models and polish that fit your game,
replace or delete the rest, and update its playtests in tests/ as you change its mechanics.
` : ''}
Next steps:
${shown === '.' ? '' : `  cd ${shown}\n`}  parallax check .   compile and check it (0 errors, 0 warnings)
  parallax test .    run its playtests
  parallax edit .    open it in the editor (Play runs it)

`);
  return 0;
}
