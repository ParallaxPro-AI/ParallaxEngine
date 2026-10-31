/**
 * `parallax.procgen` (sdk/parallax/procgen.pyi): the Spline, Sweep, Track, Structure,
 * Dungeon and GeneratedPiece component handles, their records (SweepPart, ProcMaterial,
 * StructureFloor, RoomStyle, Roof, Facade, Shutters, Mullions, Awnings, Balconies, and the Track's
 * TrackSurface, TrackEdgeLines, TrackKerbs, TrackRunoff, TrackBarrier, TrackCrowd, TrackGantry, TrackSigns, TrackGrade), the built-in `profile` and `prop_kit` content kinds, the
 * values the components' methods return, and the `procgen()` factory
 * (`parallax.plugins.procgen`). Geometry lives in the procgen plugin.
 */

import { Color, Vec2 } from '../core/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import {
  DUNGEON, DUNGEON_SCHEMA, PIECE, PIECE_SCHEMA, procgen as procgenPlugin, SPLINE, SPLINE_SCHEMA, STRUCTURE,
  STRUCTURE_SCHEMA, SWEEP, SWEEP_SCHEMA, TRACK, TRACK_SCHEMA,
} from '../function/plugins/procgen/index.js';
import { content, declareBuiltIns, record } from './declarations.js';
import { componentHandle } from './handles.js';
import { bindArgs } from './kwargs.js';
import { field, PrefabRef, rt } from './types.js';

export { GeneratedDoor, GeneratedRoom, GeneratedStair, PathHit, PathPoint } from '../function/plugins/procgen/index.js';

/** A path through control points (entity-local): `sample`, `nearest`, `progress`, `polyline`, `length`. */
export const Spline = componentHandle({ id: SPLINE, schema: SPLINE_SCHEMA }, 'Spline');
/** Profiles swept along the entity's Spline (roads, kerbs, rails, tubes). */
export const Sweep = componentHandle({ id: SWEEP, schema: SWEEP_SCHEMA }, 'Sweep');
/** A race track along the entity's Spline (road, kerbs, run-off, barriers, stands, gantry): `racing_line`, `surface_at`, `corners`. */
export const Track = componentHandle({ id: TRACK, schema: TRACK_SCHEMA }, 'Track');
/** A building from character-grid floor plans: `rooms`, `doors`, `stairs`, `room_at`. */
export const Structure = componentHandle({ id: STRUCTURE, schema: STRUCTURE_SCHEMA }, 'Structure');
/** A seeded dungeon (mission → layout → geometry → pieces): `rooms`, `doors`, `entrance`, `room_at`. */
export const Dungeon = componentHandle({ id: DUNGEON, schema: DUNGEON_SCHEMA }, 'Dungeon');
/** On every entity a Structure or Dungeon spawned: source, role, room, lock. */
export const GeneratedPiece = componentHandle({ id: PIECE, schema: PIECE_SCHEMA }, 'GeneratedPiece');

class ProcMaterialFields {
  static readonly __annotations__ = {
    color: () => Color, texture: () => rt.str, normal_map: () => rt.str, tile: () => rt.float, roughness: () => rt.float, metallic: () => rt.float,
  };
  static readonly color = Color.hex('#9a9a9a');
  static readonly texture = '';
  static readonly normal_map = '';
  static readonly tile = 1;
  static readonly roughness = 0.85;
  static readonly metallic = 0;
}
/** How a generated part looks: `ProcMaterial(color=Color.hex("#d8cfc0"), texture="assets/images/brick.png", tile=2)`. */
export const ProcMaterial = record(ProcMaterialFields);

class SweepPartFields {
  static readonly __annotations__ = {
    profile: () => rt.str, width: () => rt.optional(rt.float), height: () => rt.optional(rt.float), offset: () => Vec2, mirror: () => rt.bool,
    color: () => Color, colors: () => rt.list(Color), stripe: () => rt.optional(rt.float), texture: () => rt.str, uv_length: () => rt.float,
    uv_width: () => rt.optional(rt.float), start: () => rt.float, end: () => rt.optional(rt.float), caps: () => rt.bool, collide: () => rt.bool,
    shadows: () => rt.bool, double_sided: () => rt.bool, roughness: () => rt.float, metallic: () => rt.float,
  };
  static readonly profile = 'road';
  static readonly width = null;
  static readonly height = null;
  static readonly offset = new Vec2(0, 0);
  static readonly mirror = false;
  static readonly color = Color.hex('#7a7a7a');
  static readonly colors = field([]);
  static readonly stripe = null;
  static readonly texture = '';
  static readonly uv_length = 4;
  static readonly uv_width = null;
  static readonly start = 0;
  static readonly end = null;
  static readonly caps = false;
  static readonly collide = true;
  static readonly shadows = true;
  static readonly double_sided = false;
  static readonly roughness = 0.85;
  static readonly metallic = 0;
}
/** One profile of a Sweep: `SweepPart(profile="kerb", offset=Vec2(5.5, 0), mirror=True, stripe=2, colors=[...])`. */
export const SweepPart = record(SweepPartFields);

class StructureFloorFields {
  static readonly __annotations__ = { plan: () => rt.list(rt.str), height: () => rt.float };
  static readonly plan = field([]);
  static readonly height = 3;
}
/** One storey of a Structure: rows of plan characters, and its height (slab included). */
export const StructureFloor = record(StructureFloorFields);

class RoomStyleFields {
  static readonly __annotations__ = { name: () => rt.str, floor: () => rt.str, height: () => rt.optional(rt.float) };
  static readonly name = '';
  static readonly floor = 'floor';
  static readonly height = null;
}
/** A Structure legend entry: the room's name, its floor's material key and its own wall height. */
export const RoomStyle = record(RoomStyleFields);

const levels = () => rt.optional(rt.list(rt.int));
const openings = () => rt.literal('windows', 'doors', 'all');

class ShuttersFields {
  static readonly __annotations__ = { width: () => rt.float, levels };
  static readonly width = 0.5;
  static readonly levels = null;
}
/** Structure facade: a leaf either side of every exterior window, folded back against the wall. */
export const Shutters = record(ShuttersFields);

class MullionsFields {
  static readonly __annotations__ = { spacing: () => rt.float, width: () => rt.float, levels };
  static readonly spacing = 1.2;
  static readonly width = 0.06;
  static readonly levels = null;
}
/** Structure facade: bars through every exterior window, no pane wider than `spacing`. */
export const Mullions = record(MullionsFields);

class AwningsFields {
  static readonly __annotations__ = { on: openings, depth: () => rt.float, drop: () => rt.float, rise: () => rt.float, levels };
  static readonly on = 'windows';
  static readonly depth = 1.1;
  static readonly drop = 0.25;
  static readonly rise = 0.15;
  static readonly levels = null;
}
/** Structure facade: a cloth canopy raked out over exterior openings. */
export const Awnings = record(AwningsFields);

class BalconiesFields {
  static readonly __annotations__ = { on: openings, depth: () => rt.float, rail: () => rt.float, levels };
  static readonly on = 'windows';
  static readonly depth = 1;
  static readonly rail = 0.95;
  static readonly levels = null;
}
/** Structure facade: a slab with rails in front of exterior openings (upper storeys by default). */
export const Balconies = record(BalconiesFields);

class RoofFields {
  static readonly __annotations__ = {
    kind: () => rt.literal('flat', 'gable', 'hip', 'shed', 'none'), pitch: () => rt.float, overhang: () => rt.float, access: () => rt.bool,
    parapet: () => rt.float, coping: () => rt.bool,
  };
  static readonly kind = 'gable';
  static readonly pitch = 30;
  static readonly overhang = 0.3;
  static readonly access = false;
  static readonly parapet = 0;
  static readonly coping = false;
}
/** A Structure's roof: `Roof(kind="flat", access=True, parapet=0.75, coping=True)`. */
export const Roof = record(RoofFields);

class FacadeFields {
  static readonly __annotations__ = {
    plinth: () => rt.float, shutters: () => rt.optional(Shutters), mullions: () => rt.optional(Mullions), awnings: () => rt.optional(Awnings),
    balconies: () => rt.optional(Balconies),
  };
  static readonly plinth = 0;
  static readonly shutters = null;
  static readonly mullions = null;
  static readonly awnings = null;
  static readonly balconies = null;
}
/** A Structure's exterior dressing: `Facade(plinth=0.55, mullions=Mullions(), awnings=Awnings(levels=[0]))`. */
export const Facade = record(FacadeFields);

class TrackSurfaceFields {
  static readonly __annotations__ = {
    color: () => Color, texture: () => rt.str, tile: () => rt.float, roughness: () => rt.float, crown: () => rt.float,
  };
  static readonly color = Color.hex('#4a4a52');
  static readonly texture = '';
  static readonly tile = 6;
  static readonly roughness = 0.72;
  static readonly crown = 0.1;
}
/** A Track's tarmac: `TrackSurface(texture="assets/images/asphalt.jpg")`. */
export const TrackSurface = record(TrackSurfaceFields);

class TrackEdgeLinesFields {
  static readonly __annotations__ = { width: () => rt.float, inset: () => rt.float, color: () => Color };
  static readonly width = 0.22;
  static readonly inset = 0.3;
  static readonly color = Color.hex('#f2ece0');
}
/** Painted lines along a Track's tarmac edges. */
export const TrackEdgeLines = record(TrackEdgeLinesFields);

class TrackKerbsFields {
  static readonly __annotations__ = {
    on: () => rt.literal('corners', 'apex', 'full', 'none'), width: () => rt.float, height: () => rt.float, stripe: () => rt.float,
    colors: () => rt.list(Color), radius: () => rt.float, extend: () => rt.float,
  };
  static readonly on = 'corners';
  static readonly width = 1.1;
  static readonly height = 0.11;
  static readonly stripe = 2.2;
  static readonly colors = field([Color.hex('#e0453f'), Color.hex('#f2ece0')]);
  static readonly radius = 120;
  static readonly extend = 12;
}
/** A Track's kerbs: `TrackKerbs(on="full")`. */
export const TrackKerbs = record(TrackKerbsFields);

class TrackRunoffFields {
  static readonly __annotations__ = {
    kind: () => rt.literal('gravel', 'grass', 'tarmac', 'none'), width: () => rt.float, color: () => rt.optional(Color),
  };
  static readonly kind = 'gravel';
  static readonly width = 3.5;
  static readonly color = null;
}
/** A Track's run-off verge: `TrackRunoff(kind="grass")`. */
export const TrackRunoff = record(TrackRunoffFields);

class TrackBarrierFields {
  static readonly __annotations__ = {
    kind: () => rt.literal('armco', 'wall', 'none'), gap: () => rt.float, height: () => rt.float, colors: () => rt.list(Color),
    post_every: () => rt.float, collide: () => rt.bool, tyre_walls: () => rt.bool, tyre_colors: () => rt.list(Color),
  };
  static readonly kind = 'armco';
  static readonly gap = 0.5;
  static readonly height = 0.75;
  static readonly colors = field([]);
  static readonly post_every = 4;
  static readonly collide = true;
  static readonly tyre_walls = true;
  static readonly tyre_colors = field([Color.hex('#1d1d1f'), Color.hex('#f2ece0')]);
}
/** A Track's barrier and tyre walls: `TrackBarrier(kind="wall", colors=[...])`. */
export const TrackBarrier = record(TrackBarrierFields);

class TrackCrowdFields {
  static readonly __annotations__ = {
    sections: () => rt.list(Vec2), side: () => rt.literal('both', 'left', 'right'), rows: () => rt.int, row_gap: () => rt.float,
    row_rise: () => rt.float, density: () => rt.float, setback: () => rt.float, max: () => rt.int, stands: () => rt.bool,
    stand_color: () => Color, colors: () => rt.list(Color),
  };
  static readonly sections = field([]);
  static readonly side = 'both';
  static readonly rows = 4;
  static readonly row_gap = 0.9;
  static readonly row_rise = 0.45;
  static readonly density = 1.1;
  static readonly setback = 2;
  static readonly max = 1200;
  static readonly stands = true;
  static readonly stand_color = Color.hex('#8d8a84');
  static readonly colors = field([]);
}
/** A Track's stands and spectators: `TrackCrowd(sections=[Vec2(0, 0.1)])`. */
export const TrackCrowd = record(TrackCrowdFields);

class TrackGantryFields {
  static readonly __annotations__ = { color: () => Color };
  static readonly color = Color.hex('#1f3a6b');
}
/** A Track's start gantry. */
export const TrackGantry = record(TrackGantryFields);

class TrackSignsFields {
  static readonly __annotations__ = { every: () => rt.float, colors: () => rt.list(Color) };
  static readonly every = 0;
  static readonly colors = field([]);
}
/** A Track's trackside boards: `TrackSigns(every=120)`. */
export const TrackSigns = record(TrackSignsFields);

class TrackGradeFields {
  static readonly __annotations__ = { feather: () => rt.float, paint: () => rt.optional(rt.str) };
  static readonly feather = 10;
  static readonly paint = null;
}
/** How a Track grades (and paints) the terrain under it: `TrackGrade(paint="road")`. */
export const TrackGrade = record(TrackGradeFields);

class ProfilePointFields {
  static readonly __annotations__ = {
    points: () => rt.list(Vec2), closed: () => rt.bool, smooth: () => rt.bool, width: () => rt.float, height: () => rt.float,
  };
  static readonly closed = false;
  static readonly smooth = false;
  static readonly width = 1;
  static readonly height = 1;
}
/** Built-in content kind `profile`: a custom sweep outline (content/profile/<id>.json). */
export const ProfileDef = declareBuiltIns(() => content('profile')(ProfilePointFields), 'procgen');

class KitPropFields {
  static readonly __annotations__ = {
    prefab: () => PrefabRef, place: () => rt.literal('center', 'corner', 'wall', 'floor'), weight: () => rt.float, radius: () => rt.float,
    scale: () => rt.tuple(rt.float, rt.float),
  };
  static readonly place = 'floor';
  static readonly weight = 1;
  static readonly radius = 0.5;
  static readonly scale = Object.freeze([1, 1]);
}
/** One prop of a kit. */
export const KitProp = declareBuiltIns(() => record(KitPropFields));

class PropKitFields {
  static readonly __annotations__ = {
    density: () => rt.float, max_per_room: () => rt.int, wall_step: () => rt.float, clearance: () => rt.float, inset: () => rt.float,
    props: () => rt.list(KitProp),
  };
  static readonly density = 6;
  static readonly max_per_room = 12;
  static readonly wall_step = 3;
  static readonly clearance = 1.5;
  static readonly inset = 0.8;
}
/** Built-in content kind `prop_kit`: room dressing (content/prop_kit/<id>.json). */
export const PropKitDef = declareBuiltIns(() => content('prop_kit')(PropKitFields), 'procgen');

/** `parallax.plugins.procgen()`. */
export function procgen(...args: unknown[]): KernelPlugin {
  bindArgs('procgen', args, {});
  return procgenPlugin();
}
