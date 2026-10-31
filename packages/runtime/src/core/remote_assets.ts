/**
 * Hosted assets: anywhere a project names an asset file (`assets/models/knight.glb`) it may
 * instead give the file's URL on the ParallaxPro asset store,
 *
 *   https://r2.parallaxpro.ai/assets/model_static/ab/cd/<sha256>.glb
 *
 * (`https://parallaxpro.ai/assets/…` is the same file; it is normalized to the r2 host,
 * which serves it with open CORS). The store's files are content-addressed and immutable.
 *
 * A browser fetches them directly. Runs without a network (headless playtests, servers)
 * treat them as data-only runs treat a missing file: the reference is checked for form
 * (host, path, an extension the field's kind loads) and draws or plays nothing.
 * `parallax check` checks the same form and never touches the network.
 */

/** Where hosted assets are fetched from. */
export const REMOTE_ASSET_BASE = 'https://r2.parallaxpro.ai/assets/';

/** Any absolute URL (a reference that is a URL at all, accepted or not). */
const ANY_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
/** The accepted hosts; the path after /assets/ is plain segments (no query, fragment, dot segments). */
const HOSTED = /^https:\/\/(?:r2\.|www\.)?parallaxpro\.ai\/assets\/((?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*)$/;

/** The extensions each asset kind loads from a URL. */
export const REMOTE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  models: ['.glb', '.gltf', '.model.json'],
  images: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  sfx: ['.ogg', '.mp3', '.wav', '.m4a'],
  music: ['.ogg', '.mp3', '.wav', '.m4a'],
};

const ANY_EXTENSION = [...new Set(Object.values(REMOTE_EXTENSIONS).flat())];

/** Is this reference a URL (rather than a project path or handle)? */
export function isAssetUrl(ref: string): boolean {
  return ANY_URL.test(ref);
}

/** A hosted asset URL in its canonical form (the r2 host), or undefined when `ref` isn't one. */
export function remoteAssetUrl(ref: string): string | undefined {
  const match = HOSTED.exec(ref);
  return match === null ? undefined : REMOTE_ASSET_BASE + match[1]!;
}

/** Is this a hosted asset URL (canonical or not)? */
export function isRemoteAsset(ref: string): boolean {
  return HOSTED.test(ref);
}

/**
 * What is wrong with a URL given as an asset of `kind` (`models`, `images`, `sfx`, `music`;
 * undefined: any kind), or undefined when it is a well-formed hosted asset. Shape only:
 * nothing is fetched.
 */
export function remoteAssetProblem(ref: string, kind?: string): string | undefined {
  if (!HOSTED.test(ref)) {
    return `"${ref}" is not a hosted asset URL: an asset URL is ${REMOTE_ASSET_BASE}<path> (or https://parallaxpro.ai/assets/<path>), with no query or fragment`;
  }
  const extensions = kind === undefined ? ANY_EXTENSION : REMOTE_EXTENSIONS[kind];
  if (extensions === undefined) return `"${ref}": ${kind} assets can't be hosted; they are project files under assets/${kind}/`;
  const lower = ref.toLowerCase();
  if (!extensions.some((e) => lower.endsWith(e))) {
    return `"${ref}" is not a file ${kind === undefined ? 'an asset field' : `a ${kind} field`} loads (${extensions.join(', ')})`;
  }
  return undefined;
}

/** A hosted asset's bytes, fetched directly (CORS is open). A non-2xx response rejects. */
export async function fetchRemoteAsset(url: string, fetcher: (url: string) => Promise<Response> = (u) => fetch(u)): Promise<Uint8Array> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}
