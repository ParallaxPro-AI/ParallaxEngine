/** Where the other packages live, next to this one in `packages/`. */

import { fileURLToPath } from 'node:url';

/** `packages/runtime/src/`: the engine sources `ENGINE_MODULES` paths are relative to. */
export const RUNTIME_SRC = fileURLToPath(new URL('../../runtime/src/', import.meta.url));

/** `packages/transpiler/`: run `python3 -m parallax_transpiler` from here. */
export const TRANSPILER_DIR = fileURLToPath(new URL('../../transpiler/', import.meta.url));

/** `packages/editor/src/index.ts`: the editor page's entry, bundled with the engine by `parallax edit`. */
export const EDITOR_ENTRY = fileURLToPath(new URL('../../editor/src/index.ts', import.meta.url));

/** `packages/server/src/index.ts`: the match server, bundled with a game by `parallax serve`. */
export const SERVER_ENTRY = fileURLToPath(new URL('../../server/src/index.ts', import.meta.url));
