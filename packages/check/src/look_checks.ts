/**
 * How a 3D game looks: warnings (never errors) for a game drawn with less of the engine than
 * it could use, each naming the feature that does the job. A 2D game is never checked, and
 * every rule needs a clear sign (a name, a count) so a deliberately abstract game — a
 * brick breaker of single boxes — stays quiet:
 *
 *   PP2200  the whole game is primitive shapes: no model anywhere, and several prefabs each
 *           assembled from two or more shapes (the shared library has models)
 *   PP2201  a natural object (tree, rock, bush, flower, crop…) built from shapes: foliage
 *           layers or a library model
 *   PP2202  water (a pond, river, sea…) drawn as a flat shape: a water_body
 *   PP2203  no effect anywhere — no ctx.vfx call, Effect, Particles or .vfx.json file
 *   PP2204  an outdoor scene whose look nobody tuned: no sky, skybox, clouds, weather or post
 *   PP2205  a building (house, barn, hall…) assembled from shapes: procgen Structure or a
 *           library model
 *   PP2206  a road or race track assembled from shapes: procgen Spline + Track / Sweep
 *   PP2207  outdoor ground that is one flat shape (ground, slope, hill…): a terrain block
 *   PP2208  an explosion in a game where nothing blows up (no combat or vehicles plugin, and
 *           no bomb, rocket, crash… in its code, prefabs or models): an effect sized to the event
 *
 * An entity counts as "built from shapes" when it and its children draw only `shape`
 * components: a model, structure, track, sweep or water body anywhere in it is engine art.
 * Names are matched by word ("pine_tree", "rock_2"), never inside a word ("rocket").
 */

import { resolvePrefab } from '@parallax/runtime/resource';
import type { JsonObject, SceneDoc } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';

/** 3D shape kinds (the 2D ones never draw in a 3D game). */
const SHAPES_3D = new Set(['box', 'sphere', 'capsule', 'cylinder', 'cone', 'plane']);

/** Components that draw engine art: an entity with one is not "built from shapes". */
const ART = ['model', 'structure', 'track', 'sweep', 'generated_piece', 'dungeon', 'water_body'];

/** A natural object: library pieces that draw it, and the foliage layer that grows it (none: a library model only). */
interface Natural {
  readonly pieces: string;
  readonly layer?: string;
}

const TREE = 'tree_oak, tree_pine, tree_snowy_pine, tree_birch, tree_palm, tree_willow';
const ROCK = 'rock_boulder_large, rock_small_set, rock_cliff_chunk';
const BUSH = 'bush_round, bush_flowering, berry_bush, hedge_block';
const CROP = 'crop_carrot_stages, crop_wheat_stages, crop_corn_stages, crop_pumpkin_stages, crop_tomato_stages';

/** Natural objects, by name word. */
const NATURE: Readonly<Record<string, Natural>> = {
  tree: { pieces: TREE, layer: '"kind": "tree", "species": "broadleaf"' }, trees: { pieces: TREE, layer: '"kind": "tree"' },
  forest: { pieces: TREE, layer: '"kind": "tree"' }, oak: { pieces: TREE, layer: '"kind": "tree", "species": "broadleaf"' },
  pine: { pieces: TREE, layer: '"kind": "tree", "species": "pine"' }, fir: { pieces: TREE, layer: '"kind": "tree", "species": "pine"' },
  spruce: { pieces: TREE, layer: '"kind": "tree", "species": "pine"' }, conifer: { pieces: TREE, layer: '"kind": "tree", "species": "pine"' },
  evergreen: { pieces: TREE, layer: '"kind": "tree", "species": "pine"' }, birch: { pieces: TREE, layer: '"kind": "tree", "species": "birch"' },
  willow: { pieces: TREE, layer: '"kind": "tree", "species": "willow"' }, palm: { pieces: TREE, layer: '"kind": "tree", "species": "palm"' },
  stump: { pieces: 'tree_stump, tree_dead' }, sapling: { pieces: TREE },
  bush: { pieces: BUSH, layer: '"kind": "bush"' }, shrub: { pieces: BUSH, layer: '"kind": "bush"' }, hedge: { pieces: BUSH, layer: '"kind": "bush"' },
  rock: { pieces: ROCK, layer: '"kind": "rock"' }, rocks: { pieces: ROCK, layer: '"kind": "rock"' },
  boulder: { pieces: ROCK, layer: '"kind": "rock", "species": "boulder"' },
  grass: { pieces: 'grass_tuft', layer: '"kind": "grass", "density": 40' },
  fern: { pieces: 'fern_clump', layer: '"kind": "plant", "species": "fern"' }, reed: { pieces: 'reeds_cattail', layer: '"kind": "plant", "species": "reed"' },
  cactus: { pieces: 'cactus_saguaro, cactus_prickly_pear' }, mushroom: { pieces: 'mushroom_cluster' },
  flower: { pieces: 'flower_patch_mixed, sunflower, bush_flowering' }, flowers: { pieces: 'flower_patch_mixed, sunflower, bush_flowering' },
  sunflower: { pieces: 'sunflower, crop_sunflower_stages' },
  crop: { pieces: CROP }, crops: { pieces: CROP }, wheat: { pieces: 'crop_wheat_stages' }, corn: { pieces: 'crop_corn_stages' },
  carrot: { pieces: 'crop_carrot_stages' }, pumpkin: { pieces: 'crop_pumpkin_stages' }, tomato: { pieces: 'crop_tomato_stages' },
  potato: { pieces: 'crop_potato_stages' }, strawberry: { pieces: 'crop_strawberry_stages' },
};

const WATER = new Set(['water', 'lake', 'pond', 'river', 'sea', 'ocean', 'pool', 'puddle', 'stream', 'creek', 'lagoon', 'swamp']);

const BUILDINGS = new Set(['house', 'home', 'building', 'cabin', 'cottage', 'barn', 'shed', 'hut', 'lodge', 'hall', 'room',
  'shop', 'store', 'tavern', 'inn', 'church', 'chapel', 'castle', 'warehouse', 'garage', 'farmhouse', 'bunker', 'hangar',
  'temple', 'mansion', 'chalet', 'stable', 'mill', 'school', 'office']);

const TRACKS = new Set(['track', 'racetrack', 'raceway', 'circuit', 'road', 'highway', 'coaster', 'rollercoaster']);

const GROUND = new Set(['ground', 'terrain', 'slope', 'hill', 'hills', 'mountain', 'land', 'landscape', 'island', 'valley', 'meadow', 'snowfield', 'piste']);

/** Words of an id: "PineTree_2" → pine, tree. */
function words(id: string): string[] {
  return id.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z]+/).filter((w) => w !== '');
}

/** What an entity draws, itself and its children. */
interface Look {
  /** Shape kinds, one per shape part. */
  readonly shapes: string[];
  /** Footprint (x, z, meters) of the biggest flat part: a plane, or a box far wider than tall. */
  flat?: { readonly x: number; readonly z: number };
  art: boolean;
  particles: boolean;
}

function size(shape: JsonObject): [number, number, number] {
  const s = shape['size'];
  if (Array.isArray(s) && s.length === 3 && s.every((n) => typeof n === 'number')) return s as [number, number, number];
  if (typeof s === 'number') return [s, s, s];
  return [1, 1, 1];
}

function scaleOf(scale: number | readonly number[] | undefined): [number, number, number] {
  if (typeof scale === 'number') return [scale, scale, scale];
  if (Array.isArray(scale) && scale.length === 3) return scale as [number, number, number];
  return [1, 1, 1];
}

function add(look: Look, components: Readonly<Record<string, JsonObject>>, scale: [number, number, number]): void {
  if (ART.some((c) => components[c] !== undefined)) look.art = true;
  if (components['particles'] !== undefined) look.particles = true;
  const shape = components['shape'];
  const kind = shape?.['kind'] ?? 'box';
  if (shape === undefined || typeof kind !== 'string' || !SHAPES_3D.has(kind)) return;
  look.shapes.push(kind);
  const [x, y, z] = size(shape).map((n, i) => Math.abs(n * scale[i]!)) as [number, number, number];
  // A plane is flat; a box is flat when it is far wider than it is tall.
  if (kind === 'plane' || (kind === 'box' && y * 8 <= Math.min(x, z))) {
    if (look.flat === undefined || x * z > look.flat.x * look.flat.z) look.flat = { x, z };
  }
}

function merged(base: Readonly<Record<string, JsonObject>>, over: Readonly<Record<string, JsonObject>>): Record<string, JsonObject> {
  const out: Record<string, JsonObject> = { ...base };
  for (const [id, fields] of Object.entries(over)) out[id] = { ...(base[id] ?? {}), ...fields };
  return out;
}

class Looks {
  readonly #ctx: CheckContext;
  readonly #cache = new Map<string, Look>();

  constructor(ctx: CheckContext) {
    this.#ctx = ctx;
  }

  /** A prefab's look (its children's included); unknown or cyclic prefabs look empty (data_checks reports them). */
  prefab(id: string, seen: readonly string[] = []): Look {
    const cached = this.#cache.get(id);
    if (cached !== undefined) return cached;
    const look: Look = { shapes: [], art: false, particles: false };
    if (seen.includes(id)) return look;
    let resolved: ReturnType<typeof resolvePrefab>;
    try {
      resolved = resolvePrefab(this.#ctx.project, id);
    } catch {
      return look;
    }
    add(look, resolved.components, scaleOf(resolved.scale));
    for (const child of resolved.children) {
      const inner = child.prefab === undefined ? undefined : this.prefab(child.prefab, [...seen, id]);
      const childScale = scaleOf(child.scale);
      if (inner !== undefined) {
        look.art ||= inner.art;
        look.particles ||= inner.particles;
        if (child.components['shape'] === undefined) look.shapes.push(...inner.shapes);
      }
      add(look, child.components, childScale);
    }
    this.#cache.set(id, look);
    return look;
  }

  /** A scene placement: its prefab with the placement's component overrides. */
  placed(prefab: string, components: Readonly<Record<string, JsonObject>>, scale: number | readonly number[] | undefined): Look {
    const base = this.prefab(prefab);
    if (Object.keys(components).length === 0 && scale === undefined) return base;
    let ownComponents: Readonly<Record<string, JsonObject>> = {};
    try {
      ownComponents = resolvePrefab(this.#ctx.project, prefab).components;
    } catch { /* an unknown prefab: data_checks reports it */ }
    // The root's shape and scale change; the children's parts are the prefab's.
    const look: Look = { shapes: [], art: base.art, particles: base.particles };
    add(look, merged(ownComponents, components), scaleOf(scale));
    const rootParts = ownComponents['shape'] === undefined ? 0 : 1;
    look.shapes.push(...base.shapes.slice(rootParts));
    return look;
  }
}

function builtFromShapes(look: Look): boolean {
  return look.shapes.length > 0 && !look.art;
}

function kinds(look: Look): string {
  const counts = new Map<string, number>();
  for (const k of look.shapes) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].map(([k, n]) => (n === 1 ? k : `${k} ×${n}`)).join(', ');
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/** Python sources of the game (not its playtests). */
function code(ctx: CheckContext): string {
  return ctx.files.all().filter((p) => p.endsWith('.py') && !p.startsWith('tests/')).map((p) => ctx.files.read(p)).join('\n');
}

/** Every named thing that draws: prefabs (by id) and placements that override the look (by placed id). */
interface Drawn {
  readonly name: string;
  readonly look: Look;
  readonly path: string;
  readonly pointer: string;
  readonly what: string;
}

function drawn(ctx: CheckContext, looks: Looks): Drawn[] {
  const out: Drawn[] = [];
  for (const prefab of ctx.project.prefabs.values()) {
    out.push({ name: prefab.id, look: looks.prefab(prefab.id), path: prefab.path, pointer: '', what: `Prefab "${prefab.id}"` });
  }
  for (const scene of ctx.project.scenes.values()) {
    scene.entities.forEach((placed, i) => {
      // A placement named apart from its prefab, with its own look (a "pond" from a "plane" prefab).
      if (placed.id === undefined || placed.components['shape'] === undefined) return;
      out.push({ name: placed.id, look: looks.placed(placed.prefab, placed.components, placed.scale), path: placed.origin.path,
        pointer: placed.origin.pointer ?? `/entities/${i}`, what: `Placed entity "${placed.id}"` });
    });
  }
  return out;
}

export function checkLook(ctx: CheckContext): void {
  if (ctx.decl.game === null || ctx.decl.game.mode === '2d') return;
  const looks = new Looks(ctx);
  const things = drawn(ctx, looks);
  const source = code(ctx);
  const scenes = [...ctx.project.scenes.values()];

  primitivesOnly(ctx, things, source, scenes);
  for (const thing of things) {
    if (!builtFromShapes(thing.look)) continue;
    const name = words(thing.name);
    nature(ctx, thing, name);
    water(ctx, thing, name);
    building(ctx, thing, name);
    track(ctx, thing, name);
  }
  noEffects(ctx, things, source);
  explosions(ctx, source);
  outdoors(ctx, looks, scenes);
}

/** Words that mean something in the game can blow up. */
const EXPLOSIVE = new Set(['bomb', 'bombs', 'grenade', 'rocket', 'missile', 'mine', 'mines', 'tnt', 'dynamite', 'explosive', 'explosives',
  'cannon', 'artillery', 'mortar', 'crash', 'crashes', 'wreck', 'wreckage', 'fuel', 'tank', 'firework', 'fireworks',
  'detonate', 'detonator', 'blast', 'barrel', 'nuke', 'meteor', 'volcano', 'spell', 'fireball']);

/** PP2208: an explosion where nothing explodes, such as a strike or a goal celebrated with one. */
function explosions(ctx: CheckContext, source: string): void {
  const game = ctx.decl.game!;
  if (game.plugins.some((p) => p.id === 'combat' || p.id === 'vehicles')) return;
  const py = ctx.files.all().filter((p) => p.endsWith('.py') && !p.startsWith('tests/'));
  const site = py.map((path) => ({ path, line: ctx.files.read(path).split('\n').findIndex((l) => /\bEffect\.explosion\b/.test(l) && !l.trim().startsWith('#')) }))
    .find((s) => s.line >= 0);
  const data = ctx.files.list().find((p) => p.endsWith('.json') && /"effect\/explosion"/.test(ctx.files.read(p)));
  if (site === undefined && data === undefined) return;
  // The game's code and the names of its prefabs and models; not content or UI ("glass_cannon" perk).
  const names = ctx.files.all().filter((p) => p.startsWith('prefabs/') || p.startsWith('assets/models/'));
  const named = [source, ...names].join(' ').toLowerCase().split(/[^a-z]+/);
  if (named.some((w) => EXPLOSIVE.has(w))) return;
  ctx.report('PP2208', 'This game plays an explosion, but nothing in it blows up', {
    severity: 'warning',
    ...(site !== undefined ? { path: site.path, line: site.line + 1 } : { path: data! }),
    fix: 'Match the effect to what happens, at its size: Effect.impact or Effect.dust (scale below 1) for a ball, pins or a landing, '
      + 'Effect.sparkle for a pickup or a goal, Effect.sparks for metal. An explosion brings a flash, camera shake and haze; '
      + 'celebrate a score with the UI and a sound instead. See docs/concepts/visuals.md.',
  });
}

/** PP2200: no model anywhere, and the props are assembled from shapes. */
function primitivesOnly(ctx: CheckContext, things: readonly Drawn[], source: string, scenes: readonly SceneDoc[]): void {
  const models = things.some((t) => t.look.art)
    || ctx.files.all().some((p) => p.startsWith('assets/models/'))
    || ctx.decl.project_refs.some((r) => r.ref[0] === 'Assets' && r.ref[1] === 'models')
    || scenes.some((s) => s.plugins['foliage'] !== undefined || s.plugins['voxels'] !== undefined)
    || /\b(?:Model|Structure|Track|Sweep)\(/.test(source);
  if (models) return;
  const compound = things.filter((t) => t.pointer === '' && t.look.shapes.length >= 2).sort((a, b) => b.look.shapes.length - a.look.shapes.length);
  const total = things.filter((t) => t.pointer === '').reduce((n, t) => n + t.look.shapes.length, 0);
  if (compound.length < 2 || total < 6) return;
  const first = compound[0]!;
  const names = compound.slice(0, 6).map((t) => t.name);
  ctx.report('PP2200', `Every object in this 3D game is primitive shapes (${plural(total, 'shape')}; ${names.join(', ')}${compound.length > 6 ? ', …' : ''} are each assembled from several) and it uses no model`, {
    severity: 'warning', path: first.path,
    fix: `The shared library has ~2,300 ready-made models: \`pnpm parallax library search ${words(first.name)[0] ?? first.name}\` finds them, `
      + '`pnpm parallax library add <piece> <game dir>` copies one in as a prefab (spawn Prefabs.<piece>, or "prefab": "<piece>" in a scene). '
      + `Keep shapes for what is meant to be abstract (a paddle, a goal line). See docs/concepts/visuals.md.`,
  });
}

/** PP2201: a tree, rock, bush, flower or crop made of shapes. */
function nature(ctx: CheckContext, thing: Drawn, name: readonly string[]): void {
  const word = name.find((w) => NATURE[w] !== undefined);
  if (word === undefined) return;
  const { pieces, layer } = NATURE[word]!;
  // Grass is blades per m²; the rest instances per m².
  const density = layer?.includes('"density"') === true ? '' : ', "density": 0.01';
  const foliage = layer === undefined ? ''
    : ` Many of them, scattered: add foliage() to Game(plugins=[...]) and give the scene "foliage": {"layers": [{${layer}${density}, "area": {"center": [0, 0], "size": [200, 200]}}]}; grown procedurally, seeded, swaying in the wind; "on" picks terrain layers when the scene has a terrain.`;
  ctx.report('PP2201', `${thing.what} is a ${word} built from primitive shapes (${kinds(thing.look)})`, {
    severity: 'warning', path: thing.path, ...(thing.pointer !== '' && { pointer: thing.pointer }),
    fix: `Use a library model (${pieces}…): \`pnpm parallax library search ${word}\` lists them, \`pnpm parallax library add <piece> <game dir>\` copies one in as a prefab.${foliage} See docs/concepts/visuals.md.`,
  });
}

/** PP2202: water drawn as a flat shape. */
function water(ctx: CheckContext, thing: Drawn, name: readonly string[]): void {
  const word = name.find((w) => WATER.has(w));
  // A thin strip (a lane marking, a gutter) is a stylised mark, not a body of water.
  if (word === undefined || thing.look.flat === undefined || Math.min(thing.look.flat.x, thing.look.flat.z) < 2) return;
  ctx.report('PP2202', `${thing.what} looks like ${word === 'water' ? 'water' : `a ${word}`}, drawn as a flat ${thing.look.shapes.includes('plane') ? 'plane' : 'box'} with no water_body`, {
    severity: 'warning', path: thing.path, ...(thing.pointer !== '' && { pointer: thing.pointer }),
    fix: 'Replace the shape with a water_body (water() in Game(plugins=[...])): "water_body": {"kind": "lake", "area": {"center": [0, 0], "size": [w, d]}, "depth": 3} '
      + `— waves, reflections, refraction, foam where it meets the shore; "kind": "ocean" | "pool" | "river" (with "points"). Buoyancy floats things on it. See docs/concepts/visuals.md.`,
  });
}

/** PP2205: a building assembled from shapes. */
function building(ctx: CheckContext, thing: Drawn, name: readonly string[]): void {
  const word = name.find((w) => BUILDINGS.has(w));
  if (word === undefined || thing.look.shapes.length < 3) return;
  ctx.report('PP2205', `${thing.what} is a ${word} assembled from ${plural(thing.look.shapes.length, 'primitive shape')} (${kinds(thing.look)})`, {
    severity: 'warning', path: thing.path, ...(thing.pointer !== '' && { pointer: thing.pointer }),
    fix: `Build it with procgen() Structure: draw its walls, doors (+), windows (=) and rooms in a .plan floor-plan file and give the entity "structure": {"plan": "buildings/${thing.name}.plan", "roof": {"kind": "gable"}} `
      + `(walls, glass, stairs and roof as one walkable mesh; sdk/parallax/procgen.pyi Structure). Or use a library model: \`pnpm parallax library search ${word}\`. See docs/concepts/visuals.md.`,
  });
}

/** PP2206: a road or track assembled from shapes. */
function track(ctx: CheckContext, thing: Drawn, name: readonly string[]): void {
  const word = name.find((w) => TRACKS.has(w));
  if (word === undefined || thing.look.shapes.length < 3) return;
  ctx.report('PP2206', `${thing.what} is a ${word} assembled from ${plural(thing.look.shapes.length, 'primitive shape')}`, {
    severity: 'warning', path: thing.path, ...(thing.pointer !== '' && { pointer: thing.pointer }),
    fix: 'Sweep it along a path with procgen(): "spline": {"points": [[x, y, z], ...], "closed": true} plus "track": {} (a race circuit: tarmac, kerbs, run-off, barriers, stands) '
      + `or "sweep": {"parts": [{"profile": "road", "width": 8}]} (a road, rail, coaster or pipe). Racing AI and lap counters read the Spline. See docs/concepts/visuals.md.`,
  });
}

/** PP2203: a 3D game that never plays an effect. */
function noEffects(ctx: CheckContext, things: readonly Drawn[], source: string): void {
  const game = ctx.decl.game!;
  if (Object.keys(ctx.decl.systems).length + Object.keys(ctx.decl.behaviors).length === 0) return; // a scene with no play
  // A starter with one mover (the blank-3d template) hasn't reached the moments effects are for.
  if (source.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length < 150) return;
  if (things.some((t) => t.look.particles)) return;
  if (ctx.files.all().some((p) => p.startsWith('assets/vfx/'))) return;
  if (/\bvfx\.|\bEffect\.|\bParticles\(|Assets\.vfx\b/.test(source)) return;
  if (ctx.files.list().some((p) => p.endsWith('.json') && /"(?:effect|vfx)\/[a-z0-9_]+"/.test(ctx.files.read(p)))) return;
  ctx.report('PP2203', 'This 3D game plays no visual effect: no ctx.vfx call, Particles emitter or effect file', {
    severity: 'warning', path: game.path, line: game.line,
    fix: 'Give the moments that matter an effect that fits them, at their size: ctx.vfx.play(Effect.impact, at=point, scale=0.6) on a hit, Effect.dust on landings and wheels, '
      + 'Effect.sparks for metal, Effect.sparkle for pickups (ctx.vfx.play(..., color=, scale=, count=)); celebrate scores in the UI, not with an explosion; a continuous Particles(effect=Effect.smoke) emitter, ctx.vfx.trail(entity) behind a fast object, '
      + `or a tuned assets/vfx/<name>.vfx.json ({"extends": "effect/dust", "color": ...}) for spray, splashes and dust. See docs/concepts/visuals.md.`,
  });
}

/**
 * PP2204 and PP2207: scenes that are outdoors — a terrain or foliage, or a natural object
 * (by name) placed in the scene or spawned by code in the start scene.
 */
function outdoors(ctx: CheckContext, looks: Looks, scenes: readonly SceneDoc[]): void {
  const natural = (prefab: string): boolean => words(prefab).some((w) => NATURE[w] !== undefined || WATER.has(w));
  const spawned = ctx.decl.spawns.some((s) => s.prefab !== null && natural(s.prefab));
  const start = ctx.decl.game?.start_scene;
  // A placement inherited by scenes extending its scene, or a spawned prefab, is reported once.
  const reported = new Set<string>();
  for (const scene of scenes) {
    const outside = scene.plugins['terrain'] !== undefined || scene.plugins['foliage'] !== undefined
      || scene.entities.some((p) => natural(p.prefab) || (p.id !== undefined && natural(p.id)))
      || (spawned && (scene.id === start || scenes.length === 1));
    if (!outside) continue;
    // Only a look nobody tuned: a scene that sets "post" chose its mood and may keep the default sky.
    const env = scene.environment ?? {};
    // An environment inherited unchanged from the base scene is reported there.
    const base = scene.extends === undefined ? undefined : ctx.project.scenes.get(scene.extends);
    const inherited = base !== undefined && JSON.stringify(base.environment ?? {}) === JSON.stringify(env);
    if (!inherited && !['sky', 'skybox', 'clouds', 'weather', 'atmosphere', 'post'].some((k) => env[k] !== undefined)) {
      ctx.report('PP2204', `Scene "${scene.id}" is outdoors with an untuned look: no "sky", "clouds", "weather" or "post" in its environment`, {
        severity: 'warning', path: scene.path, pointer: scene.environment === undefined ? '' : '/environment',
        fix: 'Set the scene\'s "environment": "sky": "atmosphere" (physically based air: blue noon, red sunsets, hazy distance), a "time_of_day", '
          + 'a "post" grade ({"preset": "cinematic"}, bloom, vignette), fog with "height_falloff" for valley mist, and either "clouds": {"coverage": 0.4} '
          + 'or a "weather" ("snow", "rain", "cloudy", {"preset": ..., "cycle": {...}}; add weather() to Game(plugins=[...]); it owns cloud cover and fog density). '
          + `See docs/concepts/visuals.md.`,
      });
    }
    if (scene.plugins['terrain'] !== undefined) continue;
    // Ground-named flat shapes: placed (at least 20 m across), or a plane the start scene's code spawns (sized by its spawn scale).
    const grounds: { name: string; look: Look; path: string; pointer?: string }[] = [];
    scene.entities.forEach((placed, i) => {
      if (![...words(placed.prefab), ...words(placed.id ?? '')].some((w) => GROUND.has(w))) return;
      const look = looks.placed(placed.prefab, placed.components, placed.scale);
      if (look.flat !== undefined && Math.min(look.flat.x, look.flat.z) >= 20) {
        grounds.push({ name: placed.id ?? placed.prefab, look, path: placed.origin.path, pointer: placed.origin.pointer ?? `/entities/${i}` });
      }
    });
    if (scene.id === start || scenes.length === 1) {
      for (const id of new Set(ctx.decl.spawns.flatMap((s) => (s.prefab === null ? [] : [s.prefab])))) {
        const look = looks.prefab(id);
        if (words(id).some((w) => GROUND.has(w)) && look.shapes[0] === 'plane') grounds.push({ name: id, look, path: ctx.project.prefabs.get(id)?.path ?? scene.path });
      }
    }
    for (const ground of grounds) {
      const key = `${ground.path}|${ground.pointer ?? ''}`;
      if (!builtFromShapes(ground.look) || reported.has(key)) continue;
      reported.add(key);
      ctx.report('PP2207', `Scene "${scene.id}" is outdoors on flat ground: "${ground.name}" is a ${ground.look.shapes.includes('plane') ? 'plane' : 'box'} shape`, {
        severity: 'warning', path: ground.path, ...(ground.pointer !== undefined && { pointer: ground.pointer }),
        fix: 'Give the scene a terrain (terrain() in Game(plugins=[...])): "terrain": {"size": [w, d], "max_height": 20, "hills": [...], "flats": [...], '
          + '"layers": [{"name": "grass", "pattern": "grass"}, {"name": "rock", "pattern": "rock"}], "rules": [{"layer": "rock", "slope": [28, 38]}]} — sculpted, painted ground that physics and foliage use '
          + `(sdk/parallax/terrain.pyi; place things with ctx.terrain.height_at). See docs/concepts/visuals.md.`,
      });
    }
  }
}
