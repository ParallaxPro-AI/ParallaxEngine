/**
 * Cinematic content (sdk/parallax/cinematics.pyi): each content/cinematic/*.json is read
 * with the runtime's own parser (its PP7200–PP7205 problems are reported as they are), then
 * what the parser can't see on its own:
 *
 *   PP2650  a target name is neither a `bind` name nor a placed id — in every scene the
 *           cinematic plays on load (`scenes`), else in any scene
 *   PP2651  a property track names a component that doesn't exist
 *   PP2652  ... a field it doesn't have, or one that can't be keyed
 *   PP2653  a property key's value doesn't fit the field's type
 *   PP2654  two cinematics play when the same scene loads
 *   PP2655  (warning) a keyed placed entity has no such component in data (it may get one
 *           from code), or the camera track's entity has no Camera
 *   PP2656  a cinematic that plays on scene load declares `bind` (nobody can give it)
 *   PP2657  a cinematic_trigger plays a cinematic binding names other than "activator"
 *   PP2658  a spawn key's prefab doesn't exist
 */

import { closestMatch } from '@parallax/runtime/core';
import { decode } from '@parallax/runtime/kernel';
import type { FieldType } from '@parallax/runtime/kernel';
import { ANIMATABLE_KINDS, CINEMATIC, CINEMATIC_TRIGGER, parseCinematic, targetNames } from '@parallax/runtime/plugins/cinematics';
import type { Cinematic } from '@parallax/runtime/plugins/cinematics';
import type { Json, JsonObject } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';

function pointerTo(base: string, ...parts: (string | number)[]): string {
  return [base, ...parts.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1'))].join('/');
}

/** Placed id → the components each of its placements has (prefab + placement), per scene. */
function placements(ctx: CheckContext): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const scene of ctx.project.scenes.values()) {
    const ids = new Map<string, Set<string>>();
    for (const p of scene.entities) {
      if (p.id === undefined) continue;
      const base = ctx.project.prefabs.get(p.prefab)?.components ?? {};
      ids.set(p.id, new Set([...Object.keys(base), ...Object.keys(p.components)]));
    }
    out.set(scene.id, ids);
  }
  return out;
}

export function checkCinematics(ctx: CheckContext): void {
  const entries = [...(ctx.project.content.get(CINEMATIC)?.values() ?? [])];
  const parsed = new Map<string, Cinematic>();
  const placed = placements(ctx);
  const byScene = new Map<string, string>();
  for (const entry of entries) {
    const { cinematic, diagnostics } = parseCinematic(entry.id, entry.values, entry.path);
    ctx.out.push(...diagnostics);
    if (cinematic === undefined) continue;
    parsed.set(entry.id, cinematic);
    const at = (pointer: string) => ({ path: entry.path, pointer });

    // Scenes it plays on load.
    cinematic.scenes.forEach((scene, i) => {
      const other = byScene.get(scene);
      if (other !== undefined) {
        ctx.report('PP2654', `Cinematics "${other}" and "${entry.id}" both play when scene "${scene}" loads`, {
          ...at(pointerTo('', 'scenes', i)), fix: 'One plays at a time: keep the scene in one and chain the other from CinematicEnded.',
        });
      }
      byScene.set(scene, entry.id);
    });
    if (cinematic.scenes.length > 0 && cinematic.bind.length > 0) {
      ctx.report('PP2656', `Cinematic "${entry.id}" plays on scene load but binds ${cinematic.bind.join(', ')}`, {
        ...at('/bind'), fix: 'Target placed ids instead, or play it from code with play(bind=...).',
      });
    }

    // Where its names must resolve: every autoplay scene, else some scene.
    const scenes = cinematic.scenes.length > 0
      ? cinematic.scenes.filter((s) => placed.has(s)).map((s) => placed.get(s)!)
      : [...placed.values()];
    const componentsOf = (name: string): Set<string> | undefined => {
      const found = scenes.filter((ids) => ids.has(name)).map((ids) => ids.get(name)!);
      return found.length === 0 ? undefined : new Set(found.flatMap((s) => [...s]));
    };
    const resolves = (name: string): boolean => cinematic.bind.includes(name)
      || (cinematic.scenes.length > 0 ? scenes.every((ids) => ids.has(name)) : scenes.some((ids) => ids.has(name)));
    const known = [...new Set([...cinematic.bind, ...scenes.flatMap((ids) => [...ids.keys()])])];

    // Every name the tracks use (targets, cameras, aims, despawns), with its pointer.
    for (const { name, pointer } of targetNames(cinematic)) {
      if (resolves(name)) continue;
      const guess = closestMatch(name, known);
      ctx.report('PP2650', `Cinematic "${entry.id}" targets "${name}", which is no bind name and no placed id${cinematic.scenes.length > 0 ? ` in scene${cinematic.scenes.length > 1 ? 's' : ''} ${cinematic.scenes.join(', ')}` : ''}`, {
        ...at(pointer), fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Add it to "bind" (and give it in play(bind=...)), or place an entity with that id.',
      });
    }

    // Re-walk the raw tracks for pointers (the parser kept order).
    const raw = (entry.values['tracks'] ?? []) as JsonObject[];
    cinematic.tracks.forEach((track, i) => {
      if (track.type === 'spawn') {
        track.keys.forEach((k, j) => {
          if (k.kind !== 'spawn' || ctx.project.prefabs.has(k.prefab)) return;
          const guess = closestMatch(k.prefab, [...ctx.project.prefabs.keys()]);
          ctx.report('PP2658', `Cinematic "${entry.id}" spawns "${k.prefab}", which is no prefab`, {
            ...at(pointerTo('', 'tracks', i, 'keys', j, 'prefab')), fix: guess !== undefined ? `Did you mean "${guess}"?` : `Add prefabs/${k.prefab}.prefab.json.`,
          });
        });
        return;
      }
      if (track.type === 'camera' && track.camera !== null && !cinematic.bind.includes(track.camera)) {
        const has = componentsOf(track.camera);
        if (has !== undefined && !has.has('camera')) {
          ctx.report('PP2655', `Cinematic "${entry.id}" directs "${track.camera}", which has no camera component in data`, {
            severity: 'warning', ...at(pointerTo('', 'tracks', i, 'camera')), fix: 'Name the camera entity (or leave "camera" out: the first camera).',
          });
        }
      }
      if (track.type !== 'property') return;
      const fieldPointer = pointerTo('', 'tracks', i, 'field');
      const info = ctx.components.get(track.component);
      if (info === undefined) {
        const guess = closestMatch(track.component, [...ctx.components.keys()]);
        ctx.report('PP2651', `Cinematic "${entry.id}" keys "${track.component}.${track.field}": there is no component "${track.component}"`, {
          ...at(fieldPointer), fix: guess !== undefined ? `Did you mean "${guess}.${track.field}"?` : 'Write "<component>.<field>", e.g. "light.intensity".',
        });
        return;
      }
      const spec = info.fields[track.field];
      if (spec === undefined || !ANIMATABLE_KINDS.has(spec.type.kind)) {
        const keyable = Object.entries(info.fields).filter(([, f]) => ANIMATABLE_KINDS.has(f.type.kind)).map(([n]) => n);
        ctx.report('PP2652', spec === undefined
          ? `Cinematic "${entry.id}": "${track.component}" has no field "${track.field}"`
          : `Cinematic "${entry.id}": "${track.component}.${track.field}" is a ${spec.type.kind} field, which can't be keyed`, {
          ...at(fieldPointer), fix: `Keyable fields of ${track.component}: ${keyable.join(', ') || '(none)'}.`,
        });
        return;
      }
      const rawKeys = (raw[i]?.['keys'] ?? []) as JsonObject[];
      track.keys.forEach((k, j) => {
        try {
          decode(spec.type as FieldType, k.value, `${track.component}.${track.field}`);
        } catch (e) {
          const message = e instanceof Error ? e.message.split('\n')[0] : String(e);
          ctx.report('PP2653', `Cinematic "${entry.id}": key value ${JSON.stringify(rawKeys[j]?.['value'] ?? null)} doesn't fit ${track.component}.${track.field} (${spec.type.kind})`, {
            ...at(pointerTo('', 'tracks', i, 'keys', j, 'value')), fix: message,
          });
        }
      });
      if (!cinematic.bind.includes(track.target)) {
        const has = componentsOf(track.target);
        if (has !== undefined && !has.has(track.component)) {
          ctx.report('PP2655', `Cinematic "${entry.id}" keys ${track.component}.${track.field} on "${track.target}", which has no ${track.component} in data`, {
            severity: 'warning', ...at(fieldPointer), fix: `Add "${track.component}" to it (or make sure code adds one before it plays).`,
          });
        }
      }
    });
  }

  // Triggers bind only "activator".
  const trigger = (components: Readonly<Record<string, JsonObject>>, path: string, pointer: string): void => {
    const id = components[CINEMATIC_TRIGGER]?.['cinematic'] as Json | undefined;
    if (typeof id !== 'string') return;
    const c = parsed.get(id);
    const extra = c?.bind.filter((n) => n !== 'activator') ?? [];
    if (extra.length > 0) {
      ctx.report('PP2657', `This cinematic_trigger plays "${id}", which binds ${extra.join(', ')}; a trigger gives only "activator"`, {
        path, pointer: pointerTo(pointer, 'components', CINEMATIC_TRIGGER, 'cinematic'), fix: 'Target placed ids in the cinematic, or play it from code with play(bind=...).',
      });
    }
  };
  for (const prefab of ctx.project.prefabs.values()) trigger(prefab.components, prefab.path, '');
  for (const scene of ctx.project.scenes.values()) {
    for (const p of scene.entities) if (CINEMATIC_TRIGGER in p.components) trigger(p.components, p.origin.path, p.origin.pointer);
  }
}
