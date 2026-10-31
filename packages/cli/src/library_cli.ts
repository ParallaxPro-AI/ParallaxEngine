/**
 * `parallax library …`:
 *
 *   parallax library list [--json]
 *   parallax library search <words>... [--category NAME] [--limit N] [--keyword] [--json]
 *   parallax library index
 *   parallax library add  <piece> [<piece>…] <project> [--dry-run] [--json]
 *   parallax library test [<piece>…] [--filter TEXT] [--keep]
 *
 * Every command takes `--library DIR` (repeatable): an extra library root after
 * shared_library/, before PARALLAX_LIBRARY_PATH's (library.ts `libraryRoots`).
 *
 * Exit codes: 0 ok, 1 errors (conflicts, failing playtests), 2 bad usage.
 */

import process from 'node:process';
import { checkProject } from '@parallax/check';
import { formatDiagnostic } from '@parallax/runtime/core';
import type { Diagnostic } from '@parallax/runtime/core';
import { applyAdd, formatList, isDirectory, libraryRoots, listPieces, loadLibrary, planAdd, searchPieces } from './library.js';
import type { Library } from './library.js';
import { buildIndex, indexDirs, indexStatus, loadEmbedder, pieceText, rankByMeaning, readIndex } from './library_index.js';
import { formatRun, runPiece } from './library_run.js';

export const LIBRARY_USAGE = `Usage:
  parallax library list [--json]
  parallax library search <words>... [--category NAME] [--limit N] [--keyword] [--json]
  parallax library index
  parallax library add  <piece> [<piece>...] <project> [--dry-run] [--json]
  parallax library test [<piece>...] [--filter TEXT] [--keep]
Each takes --library DIR (repeatable): another library root, searched after shared_library/.
PARALLAX_LIBRARY_PATH (folders separated by ':') adds roots after those.
`;

function print(diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) process.stderr.write(`${formatDiagnostic(d)}\n\n`);
}

function usable(library: Library): boolean {
  if (library.diagnostics.length === 0) return true;
  print(library.diagnostics);
  return !library.diagnostics.some((d) => d.severity === 'error');
}

/** `--library DIR` pairs taken out of `argv`: the folders, and the other arguments; or the usage error. */
export function libraryFlags(argv: readonly string[]): { dirs: string[]; rest: string[] } | string {
  const dirs: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--library') { rest.push(argv[i]!); continue; }
    const dir = argv[++i];
    if (dir === undefined || dir.startsWith('--')) return '--library needs a folder';
    dirs.push(dir);
  }
  return { dirs, rest };
}

/** `root`: the library's roots (tests); default shared_library/, `--library` folders, then PARALLAX_LIBRARY_PATH. */
export async function libraryMain(argv: readonly string[], root?: string | readonly string[]): Promise<number> {
  const usage = (message?: string): number => {
    process.stderr.write(`${message !== undefined ? `${message}\n\n` : ''}${LIBRARY_USAGE}`);
    return 2;
  };
  const parsed = libraryFlags(argv);
  if (typeof parsed === 'string') return usage(parsed);
  const [command, ...rest] = parsed.rest;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const library = loadLibrary(root ?? libraryRoots(parsed.dirs));
  switch (command) {
    case 'list': {
      const extra = rest.filter((a) => a !== '--json');
      if (extra.length > 0) return usage(`Unexpected argument ${extra[0]}`);
      if (!usable(library)) return 1;
      // --json: {"pieces": [{id, category, summary, version, requires, files}]} (listPieces).
      process.stdout.write(flags.has('--json') ? `${JSON.stringify({ pieces: listPieces(library) })}\n` : `${formatList(library)}\n`);
      return 0;
    }
    case 'search': {
      let category: string | undefined;
      let limit = 10;
      const terms: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (arg === '--json' || arg === '--keyword') continue;
        if (arg === '--category') {
          category = rest[++i];
          if (category === undefined) return usage('--category needs a value');
        } else if (arg === '--limit') {
          limit = Number(rest[++i]);
          if (!Number.isInteger(limit) || limit < 1) return usage('--limit needs a whole number above 0');
        } else if (arg.startsWith('--')) return usage(`Unknown option ${arg}`);
        else terms.push(arg);
      }
      if (terms.length === 0) return usage('search needs words to look for, such as: parallax library search pine tree');
      if (!usable(library)) return 1;
      const query = terms.join(' ');
      const scope = { ...(category !== undefined && { category }), limit };
      // By meaning (building or refreshing the index first when it needs it); by keyword with
      // --keyword or when the model can't be loaded.
      const embed = flags.has('--keyword') ? undefined : await loadEmbedder();
      let found;
      if (embed !== undefined) {
        let index = readIndex(library.root);
        const status = index === undefined ? { stale: [...library.pieces.keys()], restamp: false } : indexStatus(library, index);
        const stale = status.stale.length;
        if (stale > 0) {
          process.stderr.write(index === undefined
            ? `(building the search index for ${stale} pieces; this happens once and takes about half a minute)\n`
            : `(updating the search index for ${stale} changed piece${stale === 1 ? '' : 's'})\n`);
        }
        if (stale > 0 || status.restamp) {
          const built = await buildIndex(library, embed, index);
          index = built.index;
          if (built.unsaved !== undefined) {
            process.stderr.write(`(the search index could not be saved, so the next search reads it again: ${built.unsaved}; set PARALLAX_CACHE_DIR to a writable folder)\n`);
          }
        }
        found = rankByMeaning(library, index!, (await embed([query]))[0]!, query, scope);
      } else {
        if (!flags.has('--keyword')) process.stderr.write('(keyword search: the embedding model could not be loaded; it downloads once, so the first search needs the network)\n');
        found = searchPieces(library, query, { ...scope, text: pieceText });
      }
      if (flags.has('--json')) {
        process.stdout.write(`${JSON.stringify({ pieces: found })}\n`);
        return 0;
      }
      if (found.length === 0) {
        process.stdout.write(`No library piece matches "${terms.join(' ')}". Try another word for it, or browse: parallax library list\n`);
        return 0;
      }
      const width = Math.max(...found.map((p) => p.id.length));
      const lines = found.map((p) => `  ${p.id.padEnd(width)}  ${p.category.padEnd(8)}  ${p.summary}`);
      lines.push('', `Add with: parallax library add ${found[0]!.id} <project>   (several ids at once are fine)`);
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }
    case 'index': {
      if (rest.length > 0) return usage(`Unexpected argument ${rest[0]}`);
      if (!usable(library)) return 1;
      const embed = await loadEmbedder();
      if (embed === undefined) {
        process.stderr.write('The embedding model could not be loaded (it downloads once, so the first run needs the network).\n');
        return 1;
      }
      const into = indexDirs(library.root)[0]!;
      const { index, embedded, unsaved } = await buildIndex(library, embed, readIndex(library.root), 64, into);
      if (unsaved !== undefined) {
        process.stderr.write(`The search index could not be saved to ${into}: ${unsaved}. Set PARALLAX_CACHE_DIR to a writable folder.\n`);
        return 1;
      }
      process.stdout.write(`Search index: ${index.ids.length} pieces (${embedded} embedded now, the rest unchanged) in ${into}/\n`);
      return 0;
    }
    case 'add': {
      for (const f of flags) if (f !== '--dry-run' && f !== '--json') return usage(`Unknown option ${f}`);
      const args = rest.filter((a) => !a.startsWith('--'));
      if (args.length < 2) return usage('add needs at least one piece and the project folder');
      const project = args[args.length - 1]!;
      if (!isDirectory(project)) return usage(`${project} is not a folder (the project goes last)`);
      if (!usable(library)) return 1;
      const plan = planAdd(library, project, args.slice(0, -1));
      const errors = plan.diagnostics.filter((d) => d.severity === 'error');
      // planAdd adds the plugins the pieces need to game/main.py; the ones it couldn't are warnings (PP9595).
      const warnings = plan.diagnostics.filter((d) => d.severity !== 'error');
      const dryRun = flags.has('--dry-run');
      const written = errors.length === 0 && !dryRun;
      if (written) applyAdd(project, plan);
      // What the copied files clash with (an id the project already declares, a missing plugin
      // component): the rest of the project's diagnostics are its own business.
      const copied = [...plan.writes.keys()];
      const clashes = written
        ? checkProject(project, { outDir: false, assetFiles: false }).diagnostics
          .filter((d) => copied.some((path) => d.path === path || d.message.includes(path)))
        : [];
      if (flags.has('--json')) {
        process.stdout.write(`${JSON.stringify({
          ok: errors.length === 0, written: errors.length === 0 && !dryRun,
          pieces: plan.pieces.map((p) => p.id), files: copied, unchanged: plan.unchanged, plugins: plan.plugins, clashes,
          setup: plan.pieces.flatMap((p) => p.setup.map((s) => ({ piece: p.id, step: s }))),
          diagnostics: [...errors, ...warnings],
        }, null, 2)}\n`);
        return errors.length === 0 ? 0 : 1;
      }
      print([...errors, ...warnings]);
      if (errors.length > 0) {
        process.stderr.write(`Nothing was copied (${errors.length} conflict${errors.length === 1 ? '' : 's'}).\n`);
        return 1;
      }
      const lines = [`${dryRun ? 'Would copy' : 'Copied'} ${plan.pieces.map((p) => `${p.id} (${p.version})`).join(', ')} into ${project}:`];
      for (const path of plan.writes.keys()) lines.push(`  ${path}`);
      if (plan.plugins.length > 0) lines.push(`  (game/main.py: added ${plan.plugins.map((p) => `${p}()`).join(', ')} to Game(plugins=[...]))`);
      if (plan.unchanged.length > 0) lines.push(`  (${plan.unchanged.length} file${plan.unchanged.length === 1 ? '' : 's'} already there, unchanged)`);
      const steps = plan.pieces.flatMap((p) => p.setup.map((s) => `  - ${p.id}: ${s}`));
      if (steps.length > 0) lines.push('', 'Next:', ...steps);
      lines.push('', `Then: parallax check ${project}`);
      process.stdout.write(`${lines.join('\n')}\n`);
      if (clashes.length > 0) {
        process.stderr.write(`\nThe copied files clash with the project (${clashes.length}):\n\n`);
        print(clashes);
      }
      return 0;
    }
    case 'test': {
      let filter: string | undefined;
      const ids: string[] = [];
      let keep = false;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (arg === '--filter') {
          filter = rest[++i];
          if (filter === undefined) return usage('--filter needs a value');
        } else if (arg === '--keep') keep = true;
        else if (arg.startsWith('--')) return usage(`Unknown option ${arg}`);
        else ids.push(arg);
      }
      if (!usable(library)) return 1;
      const pieces = ids.length > 0 ? ids.map((id) => library.pieces.get(id)) : [...library.pieces.values()];
      const unknown = ids.filter((id) => !library.pieces.has(id));
      if (unknown.length > 0) return usage(`No library piece ${unknown.map((u) => `"${u}"`).join(', ')} (parallax library list)`);
      let failed = 0;
      for (const piece of pieces) {
        const run = await runPiece(library, piece!, { ...(filter !== undefined && { filter }), keep });
        if (!run.ok) failed++;
        process.stdout.write(`${formatRun(run)}\n`);
      }
      process.stdout.write(`${pieces.length - failed}/${pieces.length} pieces passed\n`);
      return failed === 0 ? 0 : 1;
    }
    case undefined:
    case '--help':
    case 'help':
      return usage();
    default:
      return usage(`Unknown library command ${command}`);
  }
}
