/**
 * `parallax/__project__`: what the generated `project` module (`parallax check`'s
 * codegen) builds its handles with — `Prefabs.paddle`, `Content.stage.dawn`,
 * `Assets.models.knight.clips.run`… Handles are created once, when the module loads,
 * so the same name is the same object everywhere. Content refs are bound to the running
 * game when it lists their kind (see `GameRuntime.contentList`).
 */

import { fail } from '../core/index.js';
import { ContentRef } from './content.js';
import {
  AssetRef, ClipRef, DialogueRef, EffectRef, EntityRef, ImageRef, ModelRef, MusicRef, PrefabRef, SceneRef, SoundRef, TextRef,
  WorldLayerRef,
} from './types.js';

export const prefabRef = (id: string): PrefabRef => new PrefabRef(id);
export const sceneRef = (id: string): SceneRef => new SceneRef(id);
export const placedRef = (id: string): EntityRef => new EntityRef(id);
export const worldLayerRef = (id: string): WorldLayerRef => new WorldLayerRef(id);
export const textRef = (key: string): TextRef => new TextRef(key);
export const dialogueRef = (id: string): DialogueRef => new DialogueRef(id);
/** An authored clip (`Assets.clips.wave` → "clips/wave"). */
export const clipRef = (name: string): ClipRef => new ClipRef(name);

const ASSETS: Readonly<Record<string, new (path: string) => AssetRef>> = {
  sound: SoundRef, music: MusicRef, image: ImageRef, effect: EffectRef, model: ModelRef, asset: AssetRef,
};

/** An asset handle; a model's `clips` become `.clips.<name>` ClipRefs. */
export function assetRef(kind: string, path: string, clips?: readonly string[]): AssetRef {
  const Ref = ASSETS[kind];
  if (Ref === undefined) fail('PP9004', `project module: unknown asset kind "${kind}"`, { fix: 'Regenerate it with `parallax check`.' });
  const ref = new Ref(path);
  if (clips !== undefined) {
    const named = Object.freeze(Object.fromEntries(clips.map((name) => [name, new ClipRef(name)])));
    Object.defineProperty(ref, 'clips', { value: named, enumerable: true });
  }
  return ref;
}

const contentRefs = new Map<string, ContentRef<unknown>>();

export function contentRef(kind: string, id: string): ContentRef<unknown> {
  const key = `${kind}\u0000${id}`;
  let ref = contentRefs.get(key);
  if (ref === undefined) contentRefs.set(key, (ref = new ContentRef(kind, id)));
  return ref;
}

/** The project module's ref for an entry, if it made one (engine-facing). */
export function projectContentRef(kind: string, id: string): ContentRef<unknown> | undefined {
  return contentRefs.get(`${kind}\u0000${id}`);
}
