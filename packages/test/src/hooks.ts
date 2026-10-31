/**
 * Node module hooks for a playtest process (registered by `child.ts` with
 * `module.register`). Three jobs:
 *
 *   aliases  the bare names compiled code imports (`parallax`, `parallax/<plugin>`,
 *            `parallax/__rt__`, `parallax/test`, …) → engine source files, and `project`
 *            → the build's generated `project.js`
 *   .ts      the TypeScript sources import each other with `.js` suffixes; Node strips
 *            types natively (>= 22.18) but does not remap the suffix, so a missing `.js`
 *            next to an existing `.ts` resolves to the `.ts`
 *   realms   a module under the build dir imported as `x.js?realm=N` passes `?realm=N` on
 *            to every build module it imports, so each playtest gets a fresh copy of the
 *            game's modules (module-level state, `Game(plugins=[...])` instances) while
 *            the engine stays shared
 *
 * An engine module this runtime does not ship fails the import with a message that
 * starts `PP9501 ` followed by JSON ({ specifier, importer }) — errors cross the hooks
 * thread as plain messages, and the session turns it back into a diagnostic.
 *
 * Runs on Node's hooks thread: imports nothing but Node built-ins.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface HookData {
  /** Bare specifier → file URL, for every engine module whose source exists. */
  readonly aliases: Readonly<Record<string, string>>;
  /** Bare `parallax*` specifiers the engine declares but does not ship yet. */
  readonly missing: readonly string[];
  /** The build directory, as a file URL ending in `/`. */
  readonly build: string;
}

interface ResolveContext {
  readonly parentURL?: string;
}

interface ResolveResult {
  readonly url: string;
  readonly shortCircuit?: boolean;
}

type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult | Promise<ResolveResult>;

let data: HookData = { aliases: {}, missing: [], build: 'file:///nonexistent/' };

export function initialize(init: HookData): void {
  data = init;
}

function realmOf(parentURL: string | undefined): string {
  if (parentURL === undefined || !parentURL.startsWith(data.build)) return '';
  const realm = new URL(parentURL).searchParams.get('realm');
  return realm === null ? '' : `?realm=${realm}`;
}

function inBuild(url: string): boolean {
  return url.startsWith(data.build);
}

export async function resolve(specifier: string, context: ResolveContext, next: NextResolve): Promise<ResolveResult> {
  const realm = realmOf(context.parentURL);
  if (specifier === 'project') return { url: `${data.build}project.js${realm}`, shortCircuit: true };
  const alias = data.aliases[specifier];
  if (alias !== undefined) return { url: alias, shortCircuit: true };
  if (specifier === 'parallax' || specifier.startsWith('parallax/')) {
    throw new Error(`PP9501 ${JSON.stringify({ specifier, importer: context.parentURL ?? null, known: data.missing.includes(specifier) })}`);
  }
  if (specifier.startsWith('file:') && inBuild(specifier)) return { url: specifier, shortCircuit: true };
  if ((specifier.startsWith('.') || specifier.startsWith('/')) && context.parentURL?.startsWith('file:') === true) {
    const target = new URL(specifier, context.parentURL);
    target.search = '';
    if (inBuild(target.href)) return { url: `${target.href}${realm}`, shortCircuit: true };
    const path = fileURLToPath(target);
    if (path.endsWith('.js') && !existsSync(path) && existsSync(`${path.slice(0, -3)}.ts`)) {
      return { url: pathToFileURL(`${path.slice(0, -3)}.ts`).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
