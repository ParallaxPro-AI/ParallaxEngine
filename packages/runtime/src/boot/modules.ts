/**
 * The module names compiled game code imports (contract C1), and which runtime source
 * implements each. Hosts resolve them from this table: `parallax edit` builds the browser's
 * import map and engine bundle from it, headless loaders alias with it. Paths are relative
 * to `packages/runtime/src/`; a module whose file does not exist yet is not shipped, and a
 * game that imports it is reported (PP9501) before it runs.
 */

import { diagnostic } from '../core/index.js';
import type { Diagnostic } from '../core/index.js';

export const ENGINE_MODULES: Readonly<Record<string, string>> = {
  'parallax': 'api/index.ts',
  'parallax/__rt__': 'api/pyrt/index.ts',
  'parallax/__project__': 'api/project.ts',
  'parallax/plugins': 'api/plugins.ts',
  'parallax/values': 'api/values.ts',
  'parallax/physics': 'api/physics.ts',
  'parallax/combat': 'api/combat.ts',
  'parallax/grid': 'api/grid.ts',
  'parallax/characters': 'api/characters.ts',
  'parallax/vehicles': 'api/vehicles.ts',
  'parallax/nav': 'api/nav.ts',
  'parallax/terrain': 'api/terrain.ts',
  'parallax/foliage': 'api/foliage.ts',
  'parallax/wind': 'api/wind.ts',
  'parallax/voxels': 'api/voxels.ts',
  'parallax/procgen': 'api/procgen.ts',
  'parallax/city': 'api/city.ts',
  'parallax/story': 'api/story.ts',
  'parallax/save': 'api/save.ts',
  'parallax/net': 'api/net.ts',
  'parallax/hud': 'api/hud.ts',
  'parallax/destruction': 'api/destruction.ts',
  'parallax/ai': 'api/ai.ts',
  'parallax/viewmodel': 'api/viewmodel.ts',
  'parallax/interaction': 'api/interaction.ts',
  'parallax/water': 'api/water.ts',
  'parallax/weather': 'api/weather.ts',
  'parallax/economy': 'api/economy.ts',
  'parallax/spawning': 'api/spawning.ts',
  'parallax/cinematics': 'api/cinematics.ts',
  'parallax/softbody': 'api/softbody.ts',
  'parallax/screens': 'api/screens.ts',
  'parallax/voice': 'api/voice.ts',
  'parallax/chat': 'api/chat.ts',
  'parallax/payments': 'api/payments.ts',
};

/** The generated handles module (`parallax check`'s codegen): `<build>/project.js`. */
export const PROJECT_MODULE = 'project';
export const PROJECT_MODULE_FILE = 'project.js';

/** Where the browser boot lives, for bundlers (relative to `packages/runtime/src/`). */
export const BOOT_ENTRY = 'boot/index.ts';

/**
 * The script a scripted panel's sandboxed frame loads (relative to `packages/runtime/src/`):
 * bundled on its own as `panel_frame.js` next to `boot.js`, a classic script with no imports,
 * so an opaque-origin frame loads it from any server (a module script would need CORS).
 */
export const PANEL_FRAME_ENTRY = 'platform/browser/ui/frame.ts';

/**
 * The module worker that runs engine jobs (relative to `packages/runtime/src/`): bundled as
 * `job_worker.js` next to `boot.js`; `bootBrowser({ jobWorker })` starts it.
 */
export const JOB_WORKER_ENTRY = 'boot/job_worker.ts';

/** The export of the entry module (`game/main.py`) that holds `Game(...)`. */
export const GAME_EXPORT = 'game';

/** The transpiler's build manifest (`build/manifest.json`). */
export interface BuildManifest {
  /** The entry module's path inside the build (`game/main.js`); null when there is no game/main.py. */
  readonly entry: string | null;
  readonly modules: readonly { readonly source: string; readonly output: string | null }[];
}

/**
 * The game's modules a host loads before the entry: every compiled module except tests and
 * save migrations, in manifest order. A declaration registers by being loaded, as `parallax
 * check` reads it — a panel named only by a scene's "ui" list exists although no module
 * imports it.
 */
export function gameModules(manifest: BuildManifest): string[] {
  return manifest.modules
    .filter((m) => m.output !== null && m.output !== manifest.entry && !inFolder(m.source, 'tests') && !inFolder(m.source, 'migrations'))
    .map((m) => m.output!);
}

/**
 * The game's save migrations (`migrations/*.py`), in manifest order. A host loads them
 * before the game starts, so `@migration` steps are registered when an old save loads.
 */
export function migrationModules(manifest: BuildManifest): string[] {
  return manifest.modules
    .filter((m) => m.output !== null && inFolder(m.source, 'migrations') && !inFolder(m.source, 'tests'))
    .map((m) => m.output!);
}

function inFolder(source: string, folder: string): boolean {
  return source.startsWith(`${folder}/`) || source.includes(`/${folder}/`);
}

/** PP9501: compiled code imports a module the engine does not provide. */
export function missingEngineModule(specifier: string, importer: string): Diagnostic {
  const known = specifier in ENGINE_MODULES;
  return diagnostic('PP9501', known
    ? `"${specifier}" is not implemented by this engine build yet (${ENGINE_MODULES[specifier]} is missing)`
    : `"${specifier}" is not an engine module`, {
    path: importer,
    fix: known
      ? 'Run the game on an engine build that includes this module, or remove the import until it lands.'
      : 'Import only the parallax modules the SDK lists (sdk/parallax/*.pyi), `project`, and your own modules.',
  });
}
