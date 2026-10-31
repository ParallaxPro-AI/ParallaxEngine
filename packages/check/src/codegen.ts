/**
 * The generated `project` module (sdk/project.pyi): typed handles for everything the
 * project's files define. Two outputs with the same names:
 *
 *   project.js   for compiled game code (`import { Prefabs } from 'project'`, contract C1).
 *                Handles are built by factories the api layer provides in
 *                'parallax/__project__', so their classes stay the api's business.
 *   project.pyi  for pyright, over the SDK stubs and the game's own modules.
 */

import type { CheckContext } from './context.js';

const PY_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Asset folder → (factory kind, Python ref class). */
const ASSET_KINDS: Readonly<Record<string, readonly [string, string]>> = {
  sfx: ['sound', 'SoundRef'], music: ['music', 'MusicRef'], images: ['image', 'ImageRef'], vfx: ['effect', 'EffectRef'],
  models: ['model', 'ModelRef'], clips: ['clip', 'ClipRef'],
};

/** A tree of names: leaves carry a JS expression and a Python type. */
interface Leaf { readonly js: string; readonly py: string; readonly clips?: readonly string[] }
type Tree = Map<string, Tree | Leaf>;

function isLeaf(node: Tree | Leaf): node is Leaf {
  return !(node instanceof Map);
}

export interface ProjectModule {
  readonly js: string;
  readonly pyi: string;
}

export function generateProject(ctx: CheckContext): ProjectModule {
  const namespaces = new Map<string, Tree>();
  const pyImports = new Map<string, Set<string>>([['parallax', new Set(['ContentRef'])]]);
  const need = (module: string, name: string): void => {
    const names = pyImports.get(module) ?? new Set<string>();
    names.add(name);
    pyImports.set(module, names);
  };
  /** `quiet`: an automatic name (a Localized list item's key) that simply isn't reachable as a handle. */
  const insert = (namespace: string, path: readonly string[], leaf: Leaf, origin: string, quiet = false): void => {
    let tree = namespaces.get(namespace);
    if (tree === undefined) namespaces.set(namespace, (tree = new Map()));
    for (const [i, part] of path.entries()) {
      if (!IDENTIFIER.test(part) || PY_KEYWORDS.has(part)) {
        if (quiet) return;
        ctx.report('PP1010', `"${part}" can't be a name in project.${namespace} (from ${origin})`, {
          severity: 'warning', path: origin, fix: 'Rename the file or key to a snake_case name that is not a Python keyword.',
        });
        return;
      }
      if (i === path.length - 1) {
        if (!tree.has(part)) tree.set(part, leaf);
        return;
      }
      let next = tree.get(part);
      if (next === undefined) tree.set(part, (next = new Map()));
      if (isLeaf(next)) return;
      tree = next;
    }
  };

  for (const namespace of ['Prefabs', 'Scenes', 'Placed', 'Assets', 'Content', 'Text', 'Dialogue', 'WorldLayers']) namespaces.set(namespace, new Map());

  for (const prefab of ctx.project.prefabs.values()) {
    need('parallax', 'PrefabRef');
    insert('Prefabs', [prefab.id], { js: `prefabRef(${q(prefab.id)})`, py: 'PrefabRef' }, prefab.path);
  }
  for (const scene of ctx.project.scenes.values()) {
    need('parallax', 'SceneRef');
    insert('Scenes', [scene.id], { js: `sceneRef(${q(scene.id)})`, py: 'SceneRef' }, scene.path);
    for (const placement of scene.entities) {
      if (placement.id === undefined) continue;
      need('parallax', 'EntityRef');
      insert('Placed', [placement.id], { js: `placedRef(${q(placement.id)})`, py: 'EntityRef' }, placement.origin.path);
    }
    for (const layer of scene.world?.layers.keys() ?? []) {
      need('parallax', 'WorldLayerRef');
      insert('WorldLayers', [layer], { js: `worldLayerRef(${q(layer)})`, py: 'WorldLayerRef' }, scene.world!.path);
    }
  }
  for (const [handle, path] of ctx.assets) {
    const parts = handle.split('/');
    const [kind, pyType] = ASSET_KINDS[parts[0]!] ?? ['asset', 'AssetRef'];
    need('parallax', pyType);
    const clips = kind === 'model' ? modelClips(ctx, path) : undefined;
    if (clips !== undefined) need('parallax', 'ClipRef');
    insert('Assets', parts, assetLeaf(kind, handle, pyType, clips), path);
  }
  // Asset files unchecked: what the data and code reference gets a handle (no file to read clips from).
  for (const [handle, used] of [...ctx.referencedAssets].sort(([a], [b]) => a.localeCompare(b))) {
    const parts = handle.split('/');
    const [kind, pyType] = ASSET_KINDS[parts[0]!] ?? ['asset', 'AssetRef'];
    need('parallax', pyType);
    const clips = kind === 'model' ? [...used].sort() : undefined;
    if (clips !== undefined) need('parallax', 'ClipRef');
    insert('Assets', parts, assetLeaf(kind, handle, pyType, clips), `assets/${handle}`);
  }
  for (const [kind, entries] of ctx.project.content) {
    const info = ctx.contentKinds.get(kind);
    if (info === undefined) continue;
    need(info.module, info.name);
    for (const entry of entries.values()) {
      insert('Content', [kind, entry.id], { js: `contentRef(${q(kind)}, ${q(entry.id)})`, py: `ContentRef[${info.name}]` }, entry.path);
    }
  }
  for (const key of [...ctx.textKeys].sort()) {
    need('parallax', 'TextRef');
    insert('Text', key.split('.'), { js: `textRef(${q(key)})`, py: 'TextRef' }, 'locale/en.json', !ctx.sourceKeys.has(key));
  }
  for (const id of [...ctx.dialogues].sort()) {
    need('parallax.story', 'DialogueRef');
    insert('Dialogue', [id], { js: `dialogueRef(${q(id)})`, py: 'DialogueRef' }, `story/${id}.yarn`);
  }

  const js = [
    '// Generated by `parallax check` from the project\'s files. Do not edit.',
    "import { assetRef, clipRef, contentRef, dialogueRef, placedRef, prefabRef, sceneRef, textRef, worldLayerRef } from 'parallax/__project__';",
    '',
    ...[...namespaces].map(([name, tree]) => `export const ${name} = ${jsTree(tree, '')};`),
    '',
  ].join('\n');

  const modelClasses: string[] = [];
  const pyBody = [...namespaces].map(([name, tree]) => pyTree(name, tree, '', [name], modelClasses)).join('\n\n');
  const imports = [...pyImports].sort(([a], [b]) => a.localeCompare(b))
    .map(([module, names]) => `from ${module} import ${[...names].sort().join(', ')}`);
  const pyi = [
    '"""Generated by `parallax check` from the project\'s files. Do not edit."""',
    '',
    'from typing import ClassVar',
    '',
    ...imports,
    '',
    ...modelClasses,
    pyBody,
    '',
  ].join('\n');
  return { js, pyi };
}

/** An `Assets.<folder>.<name>` leaf: a typed asset ref (a model's with its clips), or an authored clip's ClipRef. */
function assetLeaf(kind: string, handle: string, py: string, clips: readonly string[] | undefined): Leaf {
  if (kind === 'clip') return { js: `clipRef(${q(handle)})`, py };
  return { js: `assetRef(${q(kind)}, ${q(handle)}${clips ? `, ${JSON.stringify(clips)}` : ''})`, py, ...(clips !== undefined && { clips }) };
}

function q(text: string): string {
  return JSON.stringify(text);
}

function jsTree(tree: Tree, indent: string): string {
  if (tree.size === 0) return 'Object.freeze({})';
  const inner = `${indent}  `;
  const lines = [...tree].map(([name, node]) => `${inner}${name}: ${isLeaf(node) ? node.js : jsTree(node, inner)},`);
  return `Object.freeze({\n${lines.join('\n')}\n${indent}})`;
}

function pyTree(name: string, tree: Tree, indent: string, path: readonly string[], modelClasses: string[]): string {
  const inner = `${indent}    `;
  const lines = [`${indent}class ${name}:`];
  if (tree.size === 0) lines.push(`${inner}...`);
  for (const [key, node] of tree) {
    if (isLeaf(node)) {
      let type = node.py;
      if (node.clips !== undefined) {
        type = `_${[...path, key].join('_')}`;
        const clipLines = node.clips.length > 0 ? node.clips.map((c) => `        ${c}: ClassVar[ClipRef]`) : ['        ...'];
        modelClasses.push(`class ${type}(ModelRef):`, '    class clips:', ...clipLines, '', '');
      }
      lines.push(`${inner}${key}: ClassVar[${type}]`);
    } else {
      lines.push(pyTree(key, node, inner, [...path, key], modelClasses));
    }
  }
  return lines.join('\n');
}

/** Animation clip names from a glTF (.gltf JSON, or the JSON chunk of a .glb). */
function modelClips(ctx: CheckContext, path: string): string[] {
  let json: string | undefined;
  if (path.endsWith('.gltf')) json = ctx.files.read(path);
  else if (path.endsWith('.glb')) {
    const bytes = ctx.files.bytes(path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength >= 20 && view.getUint32(0, true) === 0x46546c67 && view.getUint32(16, true) === 0x4e4f534a) {
      json = new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)));
    }
  }
  if (json === undefined) return [];
  try {
    const doc = JSON.parse(json) as { animations?: { name?: string }[] };
    return (doc.animations ?? []).flatMap((a) => (a.name !== undefined && IDENTIFIER.test(a.name) && !PY_KEYWORDS.has(a.name) ? [a.name] : []));
  } catch {
    ctx.report('PP1001', 'Model has an unreadable glTF JSON chunk', { path });
    return [];
  }
}
