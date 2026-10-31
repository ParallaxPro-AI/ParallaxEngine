// Node resolve hook for running compiled modules against the TypeScript runtime source
// (Node >= 22.18 strips types natively): `parallax/__rt__` → pyrt, and the runtime's
// `.js` import suffixes → the `.ts` files that exist on disk.
import { existsSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUNTIME_SRC = new URL('../../../runtime/src/', import.meta.url);

// The engine modules compiled code imports (runtime/src/boot/modules.ts ENGINE_MODULES),
// plus the generated `project` module of the build in PARALLAX_BUILD.
function alias(specifier) {
  if (specifier === 'parallax') return new URL('api/index.ts', RUNTIME_SRC).href;
  if (specifier === 'parallax/__rt__') return new URL('api/pyrt/index.ts', RUNTIME_SRC).href;
  if (specifier === 'parallax/__project__') return new URL('api/project.ts', RUNTIME_SRC).href;
  if (/^parallax\/[a-z0-9_]+$/.test(specifier)) return new URL(`api/${specifier.slice('parallax/'.length)}.ts`, RUNTIME_SRC).href;
  if (specifier === 'project' && process.env.PARALLAX_BUILD) return pathToFileURL(`${process.env.PARALLAX_BUILD}/project.js`).href;
  return undefined;
}

export async function resolve(specifier, context, next) {
  const aliased = alias(specifier);
  if (aliased !== undefined) return { url: aliased, shortCircuit: true };
  if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('/')) && context.parentURL) {
    const target = new URL(specifier, context.parentURL);
    const path = fileURLToPath(target);
    if (!existsSync(path) && existsSync(path.slice(0, -3) + '.ts')) {
      return { url: pathToFileURL(path.slice(0, -3) + '.ts').href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
