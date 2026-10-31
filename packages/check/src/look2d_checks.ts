/**
 * How a 2D game looks: warnings (never errors) for a game drawn with less of the engine than
 * it could use, each naming the feature that does the job. A 3D game is never checked here
 * (look_checks.ts covers it). Every rule needs a clear sign, so a game that is abstract on
 * purpose — a number puzzle of colored tiles, a starter template — stays quiet:
 *
 *   PP2210  the whole game is plain colored shapes: no image anywhere (sprite, shape texture,
 *           tile image or assets/images file) in a game past the starter size
 *   PP2211  a character (player, enemy, hero, ship…) drawn as a plain shape or an imageless
 *           sprite: a sprite with an image, or an SVG in assets/images
 *   PP2212  no effect anywhere — no ctx.vfx call, particles or .vfx.json file
 *   PP2213  no camera sets a background color, so the screen clears to the default
 *
 * Also an error: Python that plays a built-in `Effect.<name>` in a 2D game (PP2063, the same
 * mistake the checker reports for "effect/<name>" in data). The 2D renderer has no built-in
 * effects, so the call fails when it runs.
 *
 * "Art" is an image (a sprite's, a shape's texture or a tile's), or vector art: a polygon or
 * a stroked shape. A plain shape is a filled rect, circle or ring with no texture or stroke.
 * Names are matched by word ("enemy_ship", "BossSlime"), never inside a word.
 */

import { resolvePrefab } from '@parallax/runtime/resource';
import type { JsonObject } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';

/** Game code shorter than this is a starter (the 2D templates), not a game yet. */
const STARTER_LINES = 150;

/** Name words of things that are characters, not abstract pieces. */
const CHARACTERS = new Set(['player', 'hero', 'heroine', 'enemy', 'enemies', 'monster', 'zombie', 'slime', 'goblin', 'orc',
  'ghost', 'knight', 'ninja', 'wizard', 'witch', 'robot', 'alien', 'ship', 'spaceship', 'character', 'boss', 'bird', 'fish',
  'cat', 'dog', 'frog', 'bat', 'spider', 'dragon', 'creature', 'villager', 'npc', 'soldier', 'pirate', 'warrior', 'mage', 'archer']);

/** Words of an id: "BossSlime_2" → boss, slime. */
function words(id: string): string[] {
  return id.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z]+/).filter((w) => w !== '');
}

/** What an entity draws, itself and its children. */
interface Look {
  /** Draws an image or vector art. */
  art: boolean;
  /** Draws a plain shape or an imageless sprite. */
  plain: boolean;
  particles: boolean;
}

function image(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

function add(look: Look, components: Readonly<Record<string, JsonObject>>): void {
  const sprite = components['sprite'];
  if (sprite !== undefined) {
    if (image(sprite['image']) || sprite['animations'] !== undefined) look.art = true;
    else look.plain = true;
  }
  const shape = components['shape'];
  if (shape !== undefined) {
    const stroke = typeof shape['stroke_width'] === 'number' && shape['stroke_width'] > 0;
    if (image(shape['texture']) || shape['kind'] === 'polygon' || stroke) look.art = true;
    else look.plain = true;
  }
  const tiles = components['tilemap']?.['tiles'];
  if (tiles !== undefined && tiles !== null && typeof tiles === 'object'
    && Object.values(tiles).some((t) => t !== null && typeof t === 'object' && image((t as JsonObject)['image']))) look.art = true;
  if (components['particles'] !== undefined) look.particles = true;
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
    const look: Look = { art: false, plain: false, particles: false };
    if (seen.includes(id)) return look;
    let resolved: ReturnType<typeof resolvePrefab>;
    try {
      resolved = resolvePrefab(this.#ctx.project, id);
    } catch {
      return look;
    }
    add(look, resolved.components);
    for (const child of resolved.children) {
      if (child.prefab !== undefined) {
        const inner = this.prefab(child.prefab, [...seen, id]);
        look.art ||= inner.art;
        look.plain ||= inner.plain;
        look.particles ||= inner.particles;
      }
      add(look, child.components);
    }
    this.#cache.set(id, look);
    return look;
  }
}

/** Python sources of the game (not its playtests), by path. */
function sources(ctx: CheckContext): { path: string; text: string }[] {
  return ctx.files.all().filter((p) => p.endsWith('.py') && !p.startsWith('tests/')).map((path) => ({ path, text: ctx.files.read(path) }));
}

function codeLines(text: string): number {
  return text.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length;
}

export function checkLook2d(ctx: CheckContext): void {
  if (ctx.decl.game === null || ctx.decl.game.mode !== '2d') return;
  const looks = new Looks(ctx);
  const py = sources(ctx);
  const source = py.map((s) => s.text).join('\n');

  builtinEffects(ctx, py);
  noBackground(ctx, source);
  // A starter (a template's square in an arena) hasn't reached the point where art and effects matter.
  if (codeLines(source) < STARTER_LINES) return;
  const prefabs = [...ctx.project.prefabs.values()].map((p) => ({ id: p.id, path: p.path, look: looks.prefab(p.id) }));
  const plainOnly = plainGame(ctx, prefabs, source);
  if (!plainOnly) characters(ctx, prefabs);
  noEffects(ctx, prefabs, source);
}

/** PP2063: `Effect.<name>` (the 3D built-ins) played from Python in a 2D game. */
function builtinEffects(ctx: CheckContext, py: readonly { path: string; text: string }[]): void {
  for (const { path, text } of py) {
    // Only the engine's Effect: imported from parallax (a game may name a class of its own Effect).
    if (!/^\s*from\s+parallax\s+import\s+(?:\([^)]*\bEffect\b[^)]*\)|[^\n]*\bEffect\b)/m.test(text)) continue;
    text.split('\n').forEach((line, i) => {
      const hit = /\bEffect\.([a-z_]+)\b/.exec(line);
      if (hit === null || line.trim().startsWith('#')) return;
      ctx.report('PP2063', `Effect.${hit[1]} is a built-in 3D effect, which a 2D game doesn't have`, {
        severity: 'error', path, line: i + 1,
        fix: `Write the effect as a file of this game, assets/vfx/${hit[1]}.vfx.json ({"burst": 24, "lifetime": 0.4, "speed": [1, 3], "spread": 360, "size": 0.12, "size_end": 0, "color": "#ffe08a", "blend": "additive"}), `
          + `and play Assets.vfx.${hit[1]}. See docs/concepts/visuals.md#2d-effects-and-juice.`,
      });
    });
  }
}

/** PP2213: no camera chooses the clear color. */
function noBackground(ctx: CheckContext, source: string): void {
  const cameras: { path: string; pointer?: string; set: boolean }[] = [];
  for (const prefab of ctx.project.prefabs.values()) {
    let camera: JsonObject | undefined;
    try {
      camera = resolvePrefab(ctx.project, prefab.id).components['camera'];
    } catch {
      continue;
    }
    if (camera !== undefined) cameras.push({ path: prefab.path, set: camera['background'] !== undefined });
  }
  for (const scene of ctx.project.scenes.values()) {
    if (scene.entities.some((p) => p.components['camera']?.['background'] !== undefined)) return;
  }
  if (cameras.length === 0 || cameras.some((c) => c.set)) return;
  // Set at run time (a sky that changes by level).
  if (/\.background\s*=/.test(source)) return;
  ctx.report('PP2213', 'No camera in this 2D game sets a "background" color, so the screen clears to the default', {
    severity: 'warning', path: cameras[0]!.path,
    fix: 'Give the camera a background that fits the setting: "camera": {"mode": "orthographic", ..., "background": "#1b2236"}, '
      + 'then fill the play area with a large sprite at a low "z" (a backdrop image) or scrolling layers. See docs/concepts/visuals.md#background-and-parallax-layers.',
  });
}

/** PP2210: nothing in the game draws an image. Returns whether it reported. */
function plainGame(ctx: CheckContext, prefabs: readonly { id: string; path: string; look: Look }[], source: string): boolean {
  if (prefabs.some((p) => p.look.art)) return false;
  if (ctx.files.all().some((p) => p.startsWith('assets/images/'))) return false;
  if (ctx.decl.project_refs.some((r) => r.ref[0] === 'Assets' && r.ref[1] === 'images')) return false;
  if (/\bimage\s*=|\.texture\s*=/.test(source)) return false;
  const plain = prefabs.filter((p) => p.look.plain);
  if (plain.length < 3) return false;
  ctx.report('PP2210', `Everything in this 2D game is a plain colored shape (${plain.slice(0, 6).map((p) => p.id).join(', ')}${plain.length > 6 ? ', …' : ''}) and it draws no image`, {
    severity: 'warning', path: plain[0]!.path,
    fix: 'Draw the things that matter (the player, enemies, pickups, props) as sprites with images: write a small SVG in assets/images/<name>.svg '
      + '(drawn white, tinted by the sprite\'s "color"), then "sprite": {"image": "images/<name>", "size": [w, h]}. '
      + 'Keep plain shapes for what is meant to be abstract (a board cell, a paddle). See docs/concepts/visuals.md#art-for-a-2d-game.',
  });
  return true;
}

/** PP2211: a character drawn as a plain shape or an imageless sprite. */
function characters(ctx: CheckContext, prefabs: readonly { id: string; path: string; look: Look }[]): void {
  for (const prefab of prefabs) {
    const word = words(prefab.id).find((w) => CHARACTERS.has(w));
    if (word === undefined || !prefab.look.plain || prefab.look.art) continue;
    ctx.report('PP2211', `Prefab "${prefab.id}" is a ${word} drawn as a plain colored shape`, {
      severity: 'warning', path: prefab.path,
      fix: `Draw it as a sprite: write assets/images/${prefab.id}.svg (a silhouette with an outline and a face or details, drawn white and tinted by "color"), `
        + `then "sprite": {"image": "images/${prefab.id}", "size": [w, h]}; add "animations" for its idle, move and hit frames. See docs/concepts/visuals.md#art-for-a-2d-game.`,
    });
  }
}

/** PP2212: a 2D game that never plays an effect. */
function noEffects(ctx: CheckContext, prefabs: readonly { look: Look }[], source: string): void {
  const game = ctx.decl.game!;
  if (Object.keys(ctx.decl.systems).length + Object.keys(ctx.decl.behaviors).length === 0) return; // a scene with no play
  if (prefabs.some((p) => p.look.particles)) return;
  if (ctx.files.all().some((p) => p.startsWith('assets/vfx/'))) return;
  if (/\bvfx\.|\bParticles\(|Assets\.vfx\b/.test(source)) return;
  if (ctx.files.list().some((p) => p.endsWith('.json') && /"vfx\/[a-z0-9_]+"/.test(ctx.files.read(p)))) return;
  ctx.report('PP2212', 'This 2D game plays no visual effect: no ctx.vfx call, particles emitter or .vfx.json file', {
    severity: 'warning', path: game.path, line: game.line,
    fix: 'Give the moments that matter an effect: write assets/vfx/<name>.vfx.json ({"burst": 24, "lifetime": 0.4, "speed": [1, 3], "spread": 360, '
      + '"size": 0.12, "size_end": 0, "color": "#ffe08a", "color_end": "#ff8a3000", "blend": "additive"}) and play it with ctx.vfx.play(Assets.vfx.<name>, at=pos) '
      + 'on hits, pickups and merges; add camera shake or ctx.time.hitstop for big ones. The built-in Effect.* set is 3D only. See docs/concepts/visuals.md#2d-effects-and-juice.',
  });
}
