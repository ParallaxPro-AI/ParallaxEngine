/**
 * The assets a project uses, for the Files tab: every 3D model, texture and sound
 * referenced from its files (a URL or a path in scenes, prefabs, config, code), plus the
 * project's own code-based models (`*.model.json`). Each is named after where it is used
 * (the key that holds it, else the file that references it), since a library URL is a hash.
 */

export type UsedAssetKind = 'models' | 'textures' | 'audio';

export interface UsedAsset {
  readonly kind: UsedAssetKind;
  /** The URL or project path, as written. */
  readonly ref: string;
  /** A readable name. */
  readonly name: string;
  /** The first file that references it (or the file itself, for a project model). */
  readonly usedBy: string;
  /** Every project file that references it, in naming order. */
  readonly usedIn: readonly string[];
}

export interface FileSource {
  list(): readonly string[];
  read(path: string): string;
}

const KIND_BY_EXT: Readonly<Record<string, UsedAssetKind>> = {
  glb: 'models', gltf: 'models', obj: 'models', fbx: 'models', vox: 'models',
  png: 'textures', jpg: 'textures', jpeg: 'textures', webp: 'textures', ktx2: 'textures', hdr: 'textures',
  mp3: 'audio', ogg: 'audio', wav: 'audio', m4a: 'audio', flac: 'audio', opus: 'audio',
};

/** Keys too generic to name an asset ("model": "...glb" is named after its file instead). */
const GENERIC_KEYS = new Set(['model', 'mesh', 'src', 'url', 'path', 'file', 'texture', 'map', 'image', 'sprite', 'icon', 'sound', 'clip', 'audio', 'music', 'ambient', 'albedo', 'normal', 'value']);

const TEXT_FILE = /\.(json|py|yarn|ts|js|txt|md)$/;
const SKIPPED = /^(build|tests?|node_modules|dist)\//;
const REF = /(["'])([^"'\s]+?\.([a-z0-9]+))\1/gi;
const KEY_BEFORE = /["']([^"']+)["']\s*:\s*$/;

/** The file's own id: `prefabs/crate.prefab.json` → crate, `scenes/arena/scene.json` → arena. */
export function fileStem(path: string): string {
  const parts = path.split('/');
  let name = parts.at(-1) ?? path;
  if (/^(scene|index|main)\.[a-z]+$/.test(name) && parts.length > 1) name = parts.at(-2)!;
  return name.replace(/(\.[a-z0-9]+)+$/i, '');
}

/** Where a project file sits in the naming order: definitions name an asset before scenes do. */
function rank(path: string): number {
  if (path === 'assets/audio.json') return 5;
  if (path.startsWith('assets/')) return 0;
  if (path.startsWith('prefabs/')) return 1;
  if (path.startsWith('config/') || path.startsWith('content/')) return 2;
  if (path.startsWith('scenes/')) return 4;
  return 3;
}

export function scanUsedAssets(files: FileSource): UsedAsset[] {
  const found = new Map<string, UsedAsset>();
  const uses = new Map<string, string[]>();
  const use = (ref: string, path: string): void => {
    const list = uses.get(ref) ?? [];
    if (!list.includes(path)) list.push(path);
    uses.set(ref, list);
  };
  const paths = files.list().filter((p) => TEXT_FILE.test(p) && !SKIPPED.test(p))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const path of paths) {
    if (path.endsWith('.model.json')) {
      if (!found.has(path)) found.set(path, { kind: 'models', ref: path, name: fileStem(path), usedBy: path, usedIn: [] });
    }
    let text: string;
    try {
      text = files.read(path);
    } catch {
      continue;
    }
    for (const match of text.matchAll(REF)) {
      const ref = match[2]!;
      const ext = match[3]!.toLowerCase();
      const kind = ref.endsWith('.model.json') ? 'models' : KIND_BY_EXT[ext];
      if (kind === undefined || ref === path) continue;
      use(ref, path);
      if (found.has(ref)) continue;
      const key = KEY_BEFORE.exec(text.slice(Math.max(0, match.index - 80), match.index))?.[1];
      found.set(ref, { kind, ref, name: nameFor(ref, path, key), usedBy: path, usedIn: [] });
    }
  }
  const assets = [...found.values()].map((a) => ({ ...a, usedIn: uses.get(a.ref) ?? [] })).sort((a, b) => a.name.localeCompare(b.name) || a.ref.localeCompare(b.ref));
  // Two assets used by one file share its name: number them.
  const seen = new Map<string, number>();
  return assets.map((a) => {
    const n = (seen.get(a.name) ?? 0) + 1;
    seen.set(a.name, n);
    return n === 1 ? a : { ...a, name: `${a.name} ${n}` };
  });
}

function nameFor(ref: string, path: string, key: string | undefined): string {
  if (ref.endsWith('.model.json')) return fileStem(ref);
  if (path === 'assets/audio.json' || key === ref) return shortName(ref);
  const stem = fileStem(path);
  const words = key?.replace(/_/g, ' ');
  // A prefab is the thing its asset draws.
  if (path.startsWith('prefabs/') || key === undefined || /^\d+$/.test(key)) return stem;
  // A model's texture slot, a scene's music: named after both ("arch normal map").
  if (path.startsWith('assets/') || GENERIC_KEYS.has(key.toLowerCase()) || /_(map|texture|image)$/i.test(key)) return `${stem} ${words}`;
  return key;
}

/** A library URL's folder and a short hash (`audio_music 2afdd6`), or a path's file name. */
function shortName(ref: string): string {
  const parts = ref.split('/');
  const file = (parts.at(-1) ?? ref).replace(/\.[a-z0-9]+$/i, '');
  if (/^[0-9a-f]{32,}$/.test(file)) {
    const folder = parts.find((p) => /^(audio|model|image)_/.test(p));
    return `${folder ?? 'asset'} ${file.slice(0, 6)}`;
  }
  return file;
}

/** One JSON-patch op (RFC 6902), as the editor's documents take them. */
export type ReplaceOp =
  | { readonly op: 'replace'; readonly pointer: string; readonly value: unknown }
  | { readonly op: 'remove'; readonly pointer: string }
  | { readonly op: 'add'; readonly pointer: string; readonly value: unknown };

const pointerPart = (key: string | number): string => `/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

/**
 * The ops that make a JSON document use `to` wherever it uses `from`: every string equal to
 * `from` is replaced, and an object key equal to it (assets/audio.json's per-file defaults)
 * is renamed. Empty when the document doesn't use it.
 */
export function replaceOps(doc: unknown, from: string, to: string): ReplaceOp[] {
  const ops: ReplaceOp[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => (item === from ? ops.push({ op: 'replace', pointer: at + pointerPart(i), value: to }) : walk(item, at + pointerPart(i))));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const rename = Object.prototype.hasOwnProperty.call(node, from) && !Object.prototype.hasOwnProperty.call(node, to);
    for (const [key, value] of Object.entries(node)) {
      if (rename && key === from) continue;
      if (value === from) ops.push({ op: 'replace', pointer: at + pointerPart(key), value: to });
      else walk(value, at + pointerPart(key));
    }
    if (rename) {
      const value = replaced((node as Record<string, unknown>)[from]);
      ops.push({ op: 'remove', pointer: at + pointerPart(from) }, { op: 'add', pointer: at + pointerPart(to), value });
    }
  };
  const replaced = (value: unknown): unknown => {
    if (value === from) return to;
    if (Array.isArray(value)) return value.map(replaced);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k === from ? to : k, replaced(v)]));
  };
  walk(doc, '');
  return ops;
}
