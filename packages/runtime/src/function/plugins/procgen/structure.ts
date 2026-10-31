/**
 * Buildings from character grids. Each floor's `plan` is rows of characters read like a
 * map: the first row is the far side (+z) and rows run toward -z; columns run along +x;
 * one `cell` meters square each. The footprint is centered on the entity (the widest row
 * decides the width, the longest floor the depth); every floor's first row is on the same
 * +z edge. Floors stack bottom up from local y = 0, each `height` meters (slab included).
 *
 * Internally a floor is a grid of [i, j] cells with i counting from the -z edge (the
 * plan's last row is i = 0), so i, like j, grows along a world axis. Problems report the
 * plan's own (text) row.
 *
 * The characters are plan.ts's PLAN_CHARACTERS (one table for the runtime, the parser,
 * the stubs and the errors):
 *
 *   #   wall           a full-height wall filling the cell
 *   +   door           an opening `door_height` tall with a lintel above; a run of `+`
 *                      is one wider door
 *   _   arch           an opening as tall as the storey's wall (no lintel, no door)
 *   =   window         a sill below `window_sill`, a head above sill + `window_height`,
 *                      and a glass pane (not solid) between
 *   |   glass wall     a full-height pane of the "glass" material along the wall line:
 *                      solid, see-through (shop fronts, conservatories, curtain walls)
 *   > < ^ v  stairs    a rectangle of one arrow is one flight climbing to the storey
 *                      above in the direction the arrow points on the map: `>` +x, `<`
 *                      -x, `^` +z (up the page), `v` -z. Nothing is inferred: the arrow
 *                      is the direction. The storey above leaves its slab out over the
 *                      flight (a stairwell: its cells there must be room)
 *   .   (or space)     void: outside, nothing built
 *   letter or digit    a room: every 4-connected group of one character is one room;
 *                      the legend may name it and pick its `floor` material (a legend
 *                      entry also makes any other unreserved character a room)
 *
 * Openings must sit in a wall line: wall-like cells (`#`, `|`, openings) on both sides
 * along x, or along z. A flight needs a room cell at its foot on its own storey and a
 * room cell to step out onto past its head on the storey above, and at most 50° of pitch
 * (steps of about 18 cm divide the storey exactly; the run's length is the going).
 * Everything else in the plan is a coded error at its row and column (`/` and `\`, the
 * old guessed-direction stairs, included).
 *
 * Room heights. A legend `height` is the room's wall height above its floor where nothing
 * is built over it (a low annex, a double-height hall under void on the storey above):
 * a wall cell rises to its tallest neighbouring room (8 neighbours; the storey's own
 * height without any), its roof sits on that, and under anything built above walls always
 * stop at the slab overhead. A room taller than its storey must have void above it.
 *
 * Geometry: a floor slab under every non-void cell (`slab` thick, top at the storey's
 * base), wall boxes over wall cells up to the slab of the storey above (or the full
 * storey where nothing is above), and a roof over every cell with nothing above it: flat
 * slabs, or per maximal rectangle of one height a gable (ridge along the longer side), hip
 * or shed roof at `pitch` degrees with `overhang` meters of eave. Boxes and slabs are
 * merged into maximal rectangles per material. Stairs are one box per tread from the
 * storey's floor to the tread's top (solid underneath, material "stair"). Solid: slabs,
 * walls, roofs, stairs and glass walls; window glass is not.
 *
 * Roof access. With a flat roof and `roof.access`, a flight on the top floor climbs onto
 * the roof deck (its rise is the storey plus the deck's slab): the deck is left out over
 * the flight (the hatch) and the cells past its head on that floor are where it lands. A
 * `parapet` (meters) stands on the deck over every exterior wall cell (one with void among
 * its 8 neighbours), `coping` caps it, oversailing 5 cm. Solid, so the deck is a floor
 * behind a wall: a second storey of play.
 *
 * Facade (exterior faces only: a wall cell's side towards void). `plinth` (meters) is a
 * base course 5 cm proud of the ground storey's walls, from the slab's underside up,
 * broken at doors and arches. Per opening with `outside` on one side: `mullions` (bars
 * through the glass, enough to keep every pane under `spacing`), `shutters` (two leaves
 * folded back flat against the wall beside a window), `awnings` (a cloth canopy raked out
 * over the head), `balconies` (a slab and three rails in front, upper storeys unless
 * `levels` says otherwise). Each picks storeys by index with `levels` (null: every storey).
 * Plinths, copings and balconies are solid; shutters, mullions and awnings are dressing
 * (`trim`), not solid: shots and jumps pass them.
 *
 * Results also list rooms (cells, area, a center cell that is inside the room), doors
 * (center, yaw facing +across the wall, width, the rooms on each side; "outside" for
 * void) and windows, for gameplay: door prefabs, spawn points, prop dressing.
 */

import type { V3 } from './mesh.js';
import { MeshBuilder } from './mesh.js';
import { PLAN_RESERVED, planCharacterList, RETIRED_PLAN_CHARACTERS, STAIR_CLIMBS } from './plan.js';
import type { PlanCellKind } from './plan.js';

/** Reserved plan character → what it builds (plan.ts PLAN_CHARACTERS; anything else is a room). */
export const STRUCTURE_RESERVED: Readonly<Record<string, PlanCellKind>> = PLAN_RESERVED;

/** Target rise of one stair step (meters); the storey is divided exactly. */
export const STAIR_RISE = 0.18;
/** Steepest flight (degrees) the plan accepts. */
export const STAIR_MAX_PITCH = 50;

export interface RoomStyle {
  readonly name: string;
  /** Material key for the room's floor. */
  readonly floor: string;
  /** Wall height above the room's floor where nothing is built over it; null: the storey's. */
  readonly height?: number | null;
}

export type RoofType = 'flat' | 'gable' | 'hip' | 'shed' | 'none';

/** Which exterior openings a facade feature dresses. */
export type OpeningSet = 'windows' | 'doors' | 'all';

/** Storeys a facade feature is on (indices into `floors`); null: its default. */
interface Levels {
  readonly levels: readonly number[] | null;
}

export interface ShutterSpec extends Levels {
  /** Leaf width as a fraction of the opening's half width. */
  readonly width: number;
}

export interface MullionSpec extends Levels {
  /** Most meters of glass between bars. */
  readonly spacing: number;
  /** Bar width (m). */
  readonly width: number;
}

export interface AwningSpec extends Levels {
  readonly on: OpeningSet;
  /** Projection from the wall face (m). */
  readonly depth: number;
  /** How far the leading edge hangs below the wall edge (m). */
  readonly drop: number;
  /** The wall edge's height above the opening's head (m). */
  readonly rise: number;
}

export interface BalconySpec extends Levels {
  readonly on: OpeningSet;
  /** Projection from the wall face (m). */
  readonly depth: number;
  /** Rail height (m); 0: none. */
  readonly rail: number;
}

export interface StructureRoof {
  readonly type: RoofType;
  readonly pitch: number;
  readonly overhang: number;
  /** Flat roofs: top-floor flights climb onto the deck. */
  readonly access?: boolean;
  /** Flat roofs: wall height above the deck over the exterior walls (m); 0: none. */
  readonly parapet?: number;
  /** Cap the parapet. */
  readonly coping?: boolean;
}

export interface StructureFacade {
  readonly shutters: ShutterSpec | null;
  readonly mullions: MullionSpec | null;
  readonly awnings: AwningSpec | null;
  readonly balconies: BalconySpec | null;
}

export const NO_FACADE: StructureFacade = { shutters: null, mullions: null, awnings: null, balconies: null };

export interface StructureSpec {
  readonly floors: readonly { readonly plan: readonly string[]; readonly height: number }[];
  readonly legend: Readonly<Record<string, RoomStyle>>;
  readonly cell: number;
  readonly slab: number;
  readonly doorHeight: number;
  readonly windowSill: number;
  readonly windowHeight: number;
  readonly roof: StructureRoof;
  /** Base course height on the ground storey's exterior walls (m); 0 or absent: none. */
  readonly plinth?: number;
  readonly facade?: StructureFacade;
  /** Where the storeys were drawn: a plan file, and the file line of each floor's rows. */
  readonly source?: { readonly path: string; readonly rows: readonly (readonly number[])[] };
}

/** Facade proportions (meters): proud of the wall face, thicknesses, the balcony's oversail. */
export const PLINTH_PROUD = 0.05;
export const COPING_HEIGHT = 0.08;
export const COPING_PROUD = 0.05;
const SHUTTER_T = 0.05;
const AWNING_T = 0.04;
const AWNING_VALANCE = 0.14;
const BALCONY_T = 0.12;
const BALCONY_OVERSAIL = 0.25;
const RAIL_T = 0.07;
const MULLION_T = 0.06;
/** How far under a flight's slope its nav side walls stop (m): nav's step height, so nothing on the slope reads them as walls. */
const NAV_STEP = 0.4;

export interface StructureProblem {
  readonly floor: number;
  readonly row: number;
  readonly column: number;
  readonly message: string;
  readonly fix: string;
}

export interface StructureRoom {
  readonly id: string;
  readonly char: string;
  readonly name: string;
  readonly floor: number;
  /** Grid cells [i, j] (i from the -z edge: the plan's last row is 0). */
  readonly cells: readonly (readonly [number, number])[];
  /** m². */
  readonly area: number;
  /** Local point on the room's floor at its most central cell. */
  readonly center: V3;
}

export interface StructureOpening {
  readonly kind: 'door' | 'arch' | 'window';
  readonly floor: number;
  /** Local point at the bottom center of the opening. */
  readonly position: V3;
  /** Degrees about +y: the direction across the wall, from `rooms[0]` to `rooms[1]`. */
  readonly yaw: number;
  /** Meters. */
  readonly width: number;
  /** Room ids on each side; "outside" for void. */
  readonly rooms: readonly [string, string];
}

/** A flight of stairs from one storey to the next. */
export interface StructureStair {
  /** The storey it climbs from (it arrives on floor + 1). */
  readonly floor: number;
  /** Grid cells [i, j] of the flight (i from the -z edge: the plan's last row is 0). */
  readonly cells: readonly (readonly [number, number])[];
  /** Local point on the floor at the middle of the flight's foot edge. */
  readonly bottom: V3;
  /** Local point on the storey above at the middle of the flight's head edge. */
  readonly top: V3;
  /** Degrees about +y: the direction of climb. */
  readonly yaw: number;
  /** Meters across the flight. */
  readonly width: number;
  readonly steps: number;
}

/**
 * Material key → surface. Solid keys: "wall" (parapets included), "roof", "slab", "stair",
 * "plinth", "coping", "balcony" and each room floor material; `trim` (not solid):
 * "shutter", "mullion", "awning".
 */
export interface StructureGeometry {
  readonly solid: Map<string, MeshBuilder>;
  readonly trim: Map<string, MeshBuilder>;
  /** Window panes (not solid). */
  readonly glass: MeshBuilder;
  /** Glass walls (`|`): solid. */
  readonly glassWalls: MeshBuilder;
  /**
   * The flights as nav should read them (not drawn, not physics): a slope strip per step
   * and side walls stopping NAV_STEP under it. Nav's clearance test would take a stepped
   * flight's risers for walls; this stands in for the "stair" part in nav's collision.
   */
  readonly navStairs: MeshBuilder;
  readonly stairs: readonly StructureStair[];
  readonly rooms: readonly StructureRoom[];
  readonly openings: readonly StructureOpening[];
  /** Local bounds of the footprint (x0, z0, x1, z1). */
  readonly footprint: readonly [number, number, number, number];
}

type CellKind = 'wall' | 'glass' | 'door' | 'arch' | 'window' | 'stair' | 'void' | 'room';

interface FloorGrid {
  readonly rows: number;
  readonly cols: number;
  kind(r: number, c: number): CellKind;
  char(r: number, c: number): string;
}

/** A floor's cells: i (r here) from the -z edge, so the plan's text row is `rows - 1 - r` (its first row is the +z edge). */
function grid(plan: readonly string[], cols: number, rows: number): FloorGrid {
  return {
    rows,
    cols,
    char: (r, c) => (r < 0 || r >= rows || c < 0 ? '.' : plan[rows - 1 - r]?.[c] ?? '.'),
    kind(r, c) {
      const ch = this.char(r, c);
      return STRUCTURE_RESERVED[ch] ?? 'room';
    },
  };
}

const wallLike = (k: CellKind): boolean => k === 'wall' || k === 'glass' || k === 'door' || k === 'arch' || k === 'window';
const solidWall = (k: CellKind): boolean => k === 'wall' || k === 'glass';

/** A parsed flight: its rectangle [r0, c0, r1, c1), climb axis and direction. */
interface Flight {
  readonly floor: number;
  readonly r0: number;
  readonly c0: number;
  readonly r1: number;
  readonly c1: number;
  readonly axis: 'x' | 'z';
  readonly dir: 1 | -1;
  /** Cells along the climb, and across it. */
  readonly len: number;
  readonly width: number;
  /** [row, column] of the cells at the foot (this storey) and past the head (the storey above). */
  readonly foot: readonly (readonly [number, number])[];
  readonly landing: readonly (readonly [number, number])[];
}

/**
 * Every flight of one floor: each 4-connected group of one stair arrow, climbing the way
 * the arrow points. Groups that aren't rectangles are problems, and so is a `^` run lying
 * in a wall line, one cell thick with solid walls at both ends (an arch written the old way).
 */
function flights(g: FloorGrid, f: number, problems: StructureProblem[] | null): Flight[] {
  const out: Flight[] = [];
  const seen = new Set<string>();
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      if (g.kind(r, c) !== 'stair' || seen.has(`${r},${c}`)) continue;
      const arrow = g.char(r, c);
      const cells: [number, number][] = [];
      const queue: [number, number][] = [[r, c]];
      seen.add(`${r},${c}`);
      while (queue.length > 0) {
        const [qr, qc] = queue.pop()!;
        cells.push([qr, qc]);
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const k = `${qr + dr},${qc + dc}`;
          if (seen.has(k) || g.char(qr + dr, qc + dc) !== arrow) continue;
          seen.add(k);
          queue.push([qr + dr, qc + dc]);
        }
      }
      const r0 = Math.min(...cells.map((p) => p[0]));
      const r1 = Math.max(...cells.map((p) => p[0])) + 1;
      const c0 = Math.min(...cells.map((p) => p[1]));
      const c1 = Math.max(...cells.map((p) => p[1])) + 1;
      const at = { floor: f, row: g.rows - r1, column: c0 };
      if (cells.length !== (r1 - r0) * (c1 - c0)) {
        problems?.push({ ...at, message: `the stair run of ${arrow} is not a rectangle`, fix: `Draw each flight as a rectangle of one arrow (${arrow}), as long as the climb needs.` });
        continue;
      }
      const solidAt = (rr: number, cc: number): boolean => solidWall(g.kind(rr, cc));
      if (arrow === '^' && ((r1 - r0 === 1 && solidAt(r0, c0 - 1) && solidAt(r0, c1)) || (c1 - c0 === 1 && solidAt(r0 - 1, c0) && solidAt(r1, c0)))) {
        problems?.push({ ...at, message: '^ is a flight of stairs climbing +z, but this run sits in a wall line like an arch', fix: 'Arches are _ now (^ climbs up the page); write this opening as _.' });
        continue;
      }
      const { axis, dir } = STAIR_CLIMBS[arrow]!;
      const across = (lo: number, hi: number, cell: (k: number) => [number, number]): [number, number][] => {
        const list: [number, number][] = [];
        for (let k = lo; k < hi; k++) list.push(cell(k));
        return list;
      };
      const before = axis === 'x' ? across(r0, r1, (k) => [k, c0 - 1]) : across(c0, c1, (k) => [r0 - 1, k]);
      const after = axis === 'x' ? across(r0, r1, (k) => [k, c1]) : across(c0, c1, (k) => [r1, k]);
      out.push({
        floor: f, r0, c0, r1, c1, axis, dir, len: axis === 'x' ? c1 - c0 : r1 - r0, width: axis === 'x' ? r1 - r0 : c1 - c0,
        foot: dir > 0 ? before : after, landing: dir > 0 ? after : before,
      });
    }
  }
  return out;
}

/** Steps of a flight up a storey `rise` meters tall. */
const stepCount = (rise: number): number => Math.max(2, Math.round(rise / STAIR_RISE));

/** Meters from floor f down to the ground. */
const floorsBelow = (spec: StructureSpec, f: number): number => Math.round(spec.floors.slice(0, f).reduce((h, fl) => h + fl.height, 0) * 10) / 10;

/** Whether top-floor flights climb onto the roof. */
const roofAccess = (spec: StructureSpec): boolean => spec.roof.access === true && spec.roof.type === 'flat';

/** How far a flight from floor f climbs: to the next storey's floor, or (the top floor, roof access) onto the deck. */
const flightRise = (spec: StructureSpec, f: number): number => spec.floors[f]!.height + (f === spec.floors.length - 1 ? spec.slab : 0);

/** Every problem in a spec's plans (empty when it builds). */
export function structureProblems(spec: StructureSpec): StructureProblem[] {
  const out: StructureProblem[] = [];
  if (spec.floors.length === 0) out.push({ floor: 0, row: 0, column: 0, message: 'has no floors', fix: 'Add "floors": [{"plan": ["#####", "#a..#", ...]}].' });
  const cols = Math.max(0, ...spec.floors.map((f) => Math.max(0, ...f.plan.map((r) => r.length))));
  const rows = Math.max(0, ...spec.floors.map((f) => f.plan.length));
  /** The plan's text row of grid row r. */
  const text = (r: number): number => rows - 1 - r;
  const retiredSeen = new Set<string>();
  spec.floors.forEach((floor, f) => {
    if (!(floor.height > spec.slab)) {
      out.push({ floor: f, row: 0, column: 0, message: `height ${floor.height} must be above the slab ${spec.slab}`, fix: 'Raise the floor height (meters per storey, slab included).' });
    }
    if (floor.height < spec.doorHeight + spec.slab && floor.plan.some((row) => row.includes('+'))) {
      out.push({ floor: f, row: 0, column: 0, message: `doors ${spec.doorHeight} m tall don't fit a ${floor.height} m storey`, fix: 'Lower door_height or raise the floor height.' });
    }
    const g = grid(floor.plan, cols, rows);
    // In reading order: the plan's first text row (the +z edge) first.
    for (let r = g.rows - 1; r >= 0; r--) {
      for (let c = 0; c < (floor.plan[text(r)]?.length ?? 0); c++) {
        const ch = g.char(r, c);
        const kind = g.kind(r, c);
        const retired = RETIRED_PLAN_CHARACTERS[ch];
        if (kind === 'room' && retired !== undefined) {
          // Once per character per floor: a whole old flight is one mistake.
          if (retiredSeen.has(`${f}|${ch}`)) continue;
          retiredSeen.add(`${f}|${ch}`);
          out.push({ floor: f, row: text(r), column: c, message: `"${ch}" is no longer a plan character`, fix: retired });
        } else if (kind === 'room' && spec.legend[ch] === undefined && !/^[A-Za-z0-9]$/.test(ch)) {
          out.push({ floor: f, row: text(r), column: c, message: `"${ch}" is not a plan character`, fix: `Use ${planCharacterList()}; or give it a legend entry.` });
        }
        if (kind === 'door' || kind === 'arch' || kind === 'window') {
          const alongX = wallLikeRun(g, r, c, 0, 1);
          const alongZ = wallLikeRun(g, r, c, 1, 0);
          if (!alongX && !alongZ) {
            out.push({ floor: f, row: text(r), column: c, message: `the ${kind} is not in a wall line`, fix: 'Put openings between wall cells (#) on both sides, along the row or the column.' });
          } else if (kind !== 'window' && (alongX ? g.kind(r, c - 1) : g.kind(r - 1, c)) !== kind) {
            // Once per run (its first cell): where does it lead?
            const [ar, ac, br, bc] = alongX ? [r - 1, c, r + 1, c] : [r, c - 1, r, c + 1];
            const a = g.kind(ar, ac);
            const b = g.kind(br, bc);
            const balconied = spec.facade?.balconies !== null && spec.facade?.balconies !== undefined && spec.facade.balconies.on !== 'windows'
              && (spec.facade.balconies.levels === null ? f > 0 : spec.facade.balconies.levels.includes(f));
            if (a === 'void' && b === 'void') {
              out.push({ floor: f, row: text(r), column: c, message: `the ${kind} opens onto nothing on either side`, fix: 'Put it in a wall between a room and the outside (or two rooms).' });
            } else if (!(wallLike(a) || a === 'stair') && !(wallLike(b) || b === 'stair') && f > 0 && (a === 'void' || b === 'void') && !balconied) {
              out.push({ floor: f, row: text(r), column: c, message: `the ${kind} on floor ${f} opens onto a ${floorsBelow(spec, f)} m drop`, fix: 'Give the building balconies on doors (facade.balconies with on="doors"), or make it a window (=).' });
            } else if (solidWall(a) || solidWall(b)) {
              out.push({ floor: f, row: text(r), column: c, message: `the ${kind} opens into a wall`, fix: 'Leave a room cell (or the outside) on both sides of the opening, across the wall.' });
            }
          }
        }
      }
    }
  });
  // Room heights, and flights against the storeys they join.
  const grids = spec.floors.map((fl) => grid(fl.plan, cols, rows));
  for (const [ch, style] of Object.entries(spec.legend)) {
    const h = style.height ?? null;
    if (h === null) continue;
    spec.floors.forEach((floor, f) => {
      if (h <= floor.height) return;
      const above = grids[f + 1];
      const g = grids[f]!;
      for (let r = 0; r < g.rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (g.kind(r, c) !== 'room' || g.char(r, c) !== ch || above === undefined || above.kind(r, c) === 'void') continue;
          out.push({ floor: f, row: text(r), column: c, message: `room "${style.name}" is ${h} m tall, above its ${floor.height} m storey, but floor ${f + 1} builds over it`, fix: `Leave the cells over it void (.) on floor ${f + 1} (a double-height room), or lower its height.` });
          return;
        }
      }
    });
  }
  const access = roofAccess(spec);
  if (spec.roof.access === true && spec.roof.type !== 'flat') {
    out.push({ floor: grids.length - 1, row: 0, column: 0, message: `roof access needs a flat roof (this one is "${spec.roof.type}")`, fix: 'Set roof.kind to "flat", or roof.access to false.' });
  }
  grids.forEach((g, f) => {
    for (const fl of flights(g, f, out)) {
      const at = { floor: f, row: text(fl.r1 - 1), column: fl.c0 };
      const above = grids[f + 1];
      if (above === undefined && !access) {
        out.push({ ...at, message: 'the stair run is on the top floor: there is nothing to climb to', fix: 'Add the storey it arrives on, set roof.kind to "flat" with roof.access true (the flight climbs onto the roof), or remove the stair cells.' });
        continue;
      }
      if (fl.foot.some(([r, c]) => g.kind(r, c) !== 'room')) {
        out.push({ ...at, message: 'the stair run has no room cell at its foot to step on from', fix: 'Leave room cells in front of the bottom step (the end the arrow points away from), or turn the arrow round.' });
      }
      if (above === undefined) {
        // Onto the roof: it lands on the deck over this floor's cells past its head.
        if (fl.landing.some(([r, c]) => g.kind(r, c) !== 'room')) {
          out.push({ ...at, message: 'the stair run has no room cell past its head to step out onto the roof from', fix: 'Make the cells just past the flight\'s top end room cells: the roof deck over them is the landing.' });
        }
      } else {
        if (fl.landing.some(([r, c]) => above.kind(r, c) !== 'room')) {
          out.push({ ...at, message: `the stair run has no room cell past its head on floor ${f + 1} to step out onto`, fix: `Make the cells just past the flight's top end (where the arrow points) room cells on floor ${f + 1}, or turn the arrow round.` });
        }
        let over = false;
        for (let r = fl.r0; r < fl.r1 && !over; r++) for (let c = fl.c0; c < fl.c1; c++) if (above.kind(r, c) !== 'room') over = true;
        if (over) {
          out.push({ ...at, message: `floor ${f + 1} is not open room over the stair run`, fix: `Put room cells (the stairwell) over every stair cell on floor ${f + 1}; its slab is left out there.` });
        }
      }
      const rise = flightRise(spec, f);
      const steps = stepCount(rise);
      const pitch = (Math.atan2(rise / steps, (fl.len * spec.cell) / steps) * 180) / Math.PI;
      if (pitch > STAIR_MAX_PITCH) {
        const want = Math.ceil(rise / Math.tan((35 * Math.PI) / 180) / spec.cell);
        out.push({ ...at, message: `the stair run climbs ${rise} m in ${fl.len * spec.cell} m (${pitch.toFixed(0)}°): a ladder, not stairs`, fix: `Draw the flight about ${want} cells long (35°), or lower the storey.` });
      }
    }
  });
  return out;
}

/**
 * Where a problem is, for its message: drawn in a plan file, the file's line and 1-based
 * column (with `path` and `line` for the diagnostic); drawn inline, the floor's row and
 * column (the caller names the component).
 */
export function problemSite(spec: StructureSpec, p: StructureProblem): { readonly text: string; readonly path?: string; readonly line?: number } {
  const src = spec.source;
  if (src === undefined) return { text: `floor ${p.floor} row ${p.row} column ${p.column}` };
  const line = src.rows[p.floor]?.[p.row];
  return { text: `${src.path} line ${line ?? '?'}, column ${p.column + 1} (floor ${p.floor})`, path: src.path, ...(line !== undefined && { line }) };
}

/** Whether the opening at (r, c) has wall-like cells on both sides along (dr, dc) — skipping a run of openings. */
function wallLikeRun(g: FloorGrid, r: number, c: number, dr: number, dc: number): boolean {
  const end = (s: number): boolean => {
    let rr = r + dr * s;
    let cc = c + dc * s;
    while (wallLike(g.kind(rr, cc))) {
      if (solidWall(g.kind(rr, cc))) return true;
      rr += dr * s;
      cc += dc * s;
    }
    return false;
  };
  return end(1) && end(-1);
}

/** Merge true cells of a rows × cols mask into maximal rectangles (row-major greedy); returns [r0, c0, r1, c1) quads. */
export function rectangles(rows: number, cols: number, on: (r: number, c: number) => boolean): Array<[number, number, number, number]> {
  const used = new Uint8Array(rows * cols);
  const out: Array<[number, number, number, number]> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (used[r * cols + c] || !on(r, c)) continue;
      let w = 1;
      while (c + w < cols && !used[r * cols + c + w] && on(r, c + w)) w++;
      let h = 1;
      grow: while (r + h < rows) {
        for (let k = 0; k < w; k++) if (used[(r + h) * cols + c + k] || !on(r + h, c + k)) break grow;
        h++;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) used[(r + y) * cols + c + x] = 1;
      out.push([r, c, r + h, c + w]);
    }
  }
  return out;
}

/** Build a valid spec (check `structureProblems` first). */
export function buildStructure(spec: StructureSpec): StructureGeometry {
  const cols = Math.max(...spec.floors.map((f) => Math.max(0, ...f.plan.map((r) => r.length))));
  const rows = Math.max(...spec.floors.map((f) => f.plan.length));
  const s = spec.cell;
  const x0 = (-cols * s) / 2;
  const z0 = (-rows * s) / 2;
  const X = (c: number): number => x0 + c * s;
  const Z = (r: number): number => z0 + r * s;
  const solid = new Map<string, MeshBuilder>();
  const part = (key: string): MeshBuilder => {
    let m = solid.get(key);
    if (m === undefined) solid.set(key, m = new MeshBuilder());
    return m;
  };
  const trim = new Map<string, MeshBuilder>();
  const dressing = (key: string): MeshBuilder => {
    let m = trim.get(key);
    if (m === undefined) trim.set(key, m = new MeshBuilder());
    return m;
  };
  const glass = new MeshBuilder();
  const glassWalls = new MeshBuilder();
  const navStairs = new MeshBuilder();
  const facade = spec.facade ?? NO_FACADE;
  const plinth = spec.plinth ?? 0;
  const access = roofAccess(spec);
  const parapet = spec.roof.type === 'flat' ? spec.roof.parapet ?? 0 : 0;
  const lastFloor = spec.floors.length - 1;
  const rooms: StructureRoom[] = [];
  const openings: StructureOpening[] = [];
  const stairs: StructureStair[] = [];
  const names = new Map<string, number>();
  const grids = spec.floors.map((f) => grid(f.plan, cols, rows));
  const bases: number[] = [];
  let base = 0;
  for (const f of spec.floors) {
    bases.push(base);
    base += f.height;
  }
  const allFlights = grids.map((g, f) => flights(g, f, null));
  /** Per floor, the cells whose slab is left out (over the flight below). */
  const wells = grids.map((_, f) => {
    const set = new Set<string>();
    for (const fl of allFlights[f - 1] ?? []) for (let r = fl.r0; r < fl.r1; r++) for (let c = fl.c0; c < fl.c1; c++) set.add(`${r},${c}`);
    return set;
  });

  /** The roof deck left out over the top floor's flights (roof access). */
  const hatch = new Set<string>();
  if (access) for (const fl of allFlights[lastFloor] ?? []) for (let r = fl.r0; r < fl.r1; r++) for (let c = fl.c0; c < fl.c1; c++) hatch.add(`${r},${c}`);

  grids.forEach((g, f) => {
    const y = bases[f]!;
    const top = y + spec.floors[f]!.height;
    const above = grids[f + 1];
    const covered = (r: number, c: number): boolean => above !== undefined && above.kind(r, c) !== 'void';
    const filled = (r: number, c: number): boolean => g.kind(r, c) !== 'void';
    const well = wells[f]!;
    /** Void, or off the plan: what an exterior face looks at. */
    const open = (r: number, c: number): boolean => g.kind(r, c) === 'void';
    const onLevel = (levels: readonly number[] | null, upperOnly = false): boolean => (levels === null ? !upperOnly || f > 0 : levels.includes(f));

    // Rooms: 4-connected groups of one character.
    const roomOf = new Map<string, string>();
    const seen = new Set<string>();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const key = `${r},${c}`;
        if (g.kind(r, c) !== 'room' || seen.has(key)) continue;
        const ch = g.char(r, c);
        const cells: [number, number][] = [];
        const queue: [number, number][] = [[r, c]];
        seen.add(key);
        while (queue.length > 0) {
          const [qr, qc] = queue.shift()!;
          cells.push([qr, qc]);
          for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nr = qr + dr;
            const nc = qc + dc;
            const nk = `${nr},${nc}`;
            if (seen.has(nk) || g.kind(nr, nc) !== 'room' || g.char(nr, nc) !== ch) continue;
            seen.add(nk);
            queue.push([nr, nc]);
          }
        }
        const style = spec.legend[ch];
        const plain = `${style?.name ?? ch}${f > 0 ? `@${f}` : ''}`;
        const dup = (names.get(plain) ?? 0) + 1;
        names.set(plain, dup);
        const id = dup === 1 ? plain : `${plain}#${dup}`;
        for (const [cr, cc] of cells) roomOf.set(`${cr},${cc}`, id);
        // Most central cell: the one nearest the cells' mean that belongs to the room.
        const mr = cells.reduce((a, p) => a + p[0], 0) / cells.length;
        const mc = cells.reduce((a, p) => a + p[1], 0) / cells.length;
        const standing = cells.filter((p) => !well.has(`${p[0]},${p[1]}`));
        let best = cells[0]!;
        let bestD = Infinity;
        for (const p of standing.length > 0 ? standing : cells) {
          const d = (p[0] - mr) ** 2 + (p[1] - mc) ** 2;
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        rooms.push({
          id, char: ch, name: style?.name ?? ch, floor: f, cells, area: cells.length * s * s,
          center: [X(best[1]) + s / 2, y, Z(best[0]) + s / 2],
        });
      }
    }

    // Floor slabs: per material (room floor material, else "slab").
    const floorKey = (r: number, c: number): string => {
      if (g.kind(r, c) === 'room') return spec.legend[g.char(r, c)]?.floor ?? 'slab';
      return 'slab';
    };
    const keys = new Set<string>();
    const slabbed = (r: number, c: number): boolean => filled(r, c) && !well.has(`${r},${c}`);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (slabbed(r, c)) keys.add(floorKey(r, c));
    for (const key of [...keys].sort()) {
      for (const [r0, c0, r1, c1] of rectangles(rows, cols, (r, c) => slabbed(r, c) && floorKey(r, c) === key)) {
        part(key).box([X(c0), y - spec.slab, Z(r0)], [X(c1), y, Z(r1)], 1);
      }
    }

    // Heights: a room's own (nothing above it) or the storey's; a wall's tallest neighbouring room.
    const roomTop = (r: number, c: number): number => {
      const h = spec.legend[g.char(r, c)]?.height ?? null;
      return covered(r, c) || h === null ? top : y + h;
    };
    const wallTop = (r: number, c: number): number => {
      if (covered(r, c)) return top - spec.slab;
      let hi = -Infinity;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (g.kind(r + dr, c + dc) === 'room') hi = Math.max(hi, roomTop(r + dr, c + dc));
      return hi === -Infinity ? top : hi;
    };
    const cellTop = (r: number, c: number): number => (g.kind(r, c) === 'room' ? roomTop(r, c) : wallLike(g.kind(r, c)) ? wallTop(r, c) : top);
    const spans: Array<{ on: (r: number, c: number) => boolean; lo: (r: number, c: number) => number; hi: (r: number, c: number) => number }> = [
      { on: (r, c) => g.kind(r, c) === 'wall', lo: () => y, hi: wallTop },
      { on: (r, c) => g.kind(r, c) === 'door', lo: () => y + spec.doorHeight, hi: wallTop },
      { on: (r, c) => g.kind(r, c) === 'window', lo: () => y, hi: () => y + spec.windowSill },
      { on: (r, c) => g.kind(r, c) === 'window', lo: () => y + spec.windowSill + spec.windowHeight, hi: wallTop },
    ];
    for (const span of spans) {
      // Group by top so merged rectangles share one height.
      const tops = new Set<number>();
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (span.on(r, c)) tops.add(span.hi(r, c));
      for (const hi of [...tops].sort((a, b) => a - b)) {
        for (const [r0, c0, r1, c1] of rectangles(rows, cols, (r, c) => span.on(r, c) && span.hi(r, c) === hi)) {
          const lo = span.lo(r0, c0);
          if (hi - lo > 1e-6) part('wall').box([X(c0), lo, Z(r0)], [X(c1), hi, Z(r1)], 1);
        }
      }
    }

    // Plinth: a strip proud of every exterior face of the ground storey, from the slab's
    // underside up; doors and arches break it; a run reaching an outer corner turns it.
    if (f === 0 && plinth > 0) {
      const lo = y - spec.slab;
      const hi = y + plinth;
      const p = PLINTH_PROUD;
      const carries = (r: number, c: number): boolean => {
        const k = g.kind(r, c);
        return k === 'wall' || k === 'glass' || k === 'window';
      };
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const alongX = dr !== 0;
        const face = (r: number, c: number): boolean => carries(r, c) && open(r + dr, c + dc);
        // Walk each line of cells along the face.
        const lines = alongX ? rows : cols;
        const span = alongX ? cols : rows;
        for (let line = 0; line < lines; line++) {
          for (let k = 0; k < span; k++) {
            const [r, c] = alongX ? [line, k] : [k, line];
            if (!face(r, c)) continue;
            let n = 1;
            while (alongX ? face(r, c + n) : face(r + n, c)) n++;
            // An outer corner (the next cell along is open too) gets the strip turned round it.
            const [er, ec] = alongX ? [r, c + n - 1] : [r + n - 1, c];
            const start = alongX ? open(r, c - 1) : open(r - 1, c);
            const end = alongX ? open(er, ec + 1) : open(er + 1, ec);
            const a0 = (alongX ? X(c) : Z(r)) - (start ? p : 0);
            const a1 = (alongX ? X(c + n) : Z(r + n)) + (end ? p : 0);
            if (alongX) {
              const z = dr < 0 ? Z(r) : Z(r + 1);
              part('plinth').box([a0, lo, Math.min(z, z + dr * p)], [a1, hi, Math.max(z, z + dr * p)], 1);
            } else {
              const x = dc < 0 ? X(c) : X(c + 1);
              part('plinth').box([Math.min(x, x + dc * p), lo, a0], [Math.max(x, x + dc * p), hi, a1], 1);
            }
            k += n - 1;
          }
        }
      }
    }

    // Glass walls: a pane through the cell's middle along its wall line (both lines at a corner), runs merged.
    const pane = Math.min(0.05, s / 4);
    const glassAlong = (r: number, c: number, axis: 'x' | 'z'): boolean => {
      if (g.kind(r, c) !== 'glass') return false;
      const x = wallLike(g.kind(r, c - 1)) || wallLike(g.kind(r, c + 1));
      const z = wallLike(g.kind(r - 1, c)) || wallLike(g.kind(r + 1, c));
      return axis === 'x' ? x || !z : z || !x;
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!glassAlong(r, c, 'x') || glassAlong(r, c - 1, 'x') && wallTop(r, c - 1) === wallTop(r, c)) continue;
        let n = 1;
        while (glassAlong(r, c + n, 'x') && wallTop(r, c + n) === wallTop(r, c)) n++;
        const cz = Z(r) + s / 2;
        glassWalls.box([X(c), y, cz - pane / 2], [X(c + n), wallTop(r, c), cz + pane / 2], 1);
      }
    }
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        if (!glassAlong(r, c, 'z') || glassAlong(r - 1, c, 'z') && wallTop(r - 1, c) === wallTop(r, c)) continue;
        let n = 1;
        while (glassAlong(r + n, c, 'z') && wallTop(r + n, c) === wallTop(r, c)) n++;
        const cx = X(c) + s / 2;
        glassWalls.box([cx - pane / 2, y, Z(r)], [cx + pane / 2, wallTop(r, c), Z(r + n)], 1);
      }
    }

    // Stairs: one box per tread, from the floor up to the tread's top; the storey is divided exactly.
    for (const fl of allFlights[f]!) {
      const rise = flightRise(spec, f);
      const steps = stepCount(rise);
      const run = fl.len * s;
      const going = run / steps;
      const [ax0, az0, ax1, az1] = [X(fl.c0), Z(fl.r0), X(fl.c1), Z(fl.r1)];
      for (let k = 0; k < steps; k++) {
        const hi = y + (rise * (k + 1)) / steps;
        const along = fl.dir > 0 ? k * going : run - (k + 1) * going;
        if (fl.axis === 'x') part('stair').box([ax0 + along, y, az0], [ax0 + along + going, hi, az1], 1);
        else part('stair').box([ax0, y, az0 + along], [ax1, hi, az0 + along + going], 1);
        // Nav's version: the slope through the treads' inner corners, one strip per step,
        // over side walls that stop NAV_STEP below it (solid under the flight, not a wall beside it).
        const s0 = fl.dir > 0 ? along : along + going;
        const s1 = fl.dir > 0 ? along + going : along;
        const y0 = y + (rise * k) / steps;
        const y1 = y + (rise * (k + 1)) / steps;
        const at = (sAlong: number, across: number, h: number): V3 => (fl.axis === 'x' ? [ax0 + sAlong, h, across] : [across, h, az0 + sAlong]);
        const [c0, c1] = fl.axis === 'x' ? [az0, az1] : [ax0, ax1];
        navStairs.quad(at(s0, c0, y0), at(s0, c1, y0), at(s1, c1, y1), at(s1, c0, y1));
        const wall = y0 - NAV_STEP;
        if (wall > y + 1e-6) for (const c of [c0, c1]) navStairs.quad(at(s0, c, y), at(s1, c, y), at(s1, c, wall), at(s0, c, wall));
      }
      const mx = (ax0 + ax1) / 2;
      const mz = (az0 + az1) / 2;
      const lowEnd: V3 = fl.axis === 'x' ? [ax0, y, mz] : [mx, y, az0];
      const highEnd: V3 = fl.axis === 'x' ? [ax1, y, mz] : [mx, y, az1];
      const [foot, head] = fl.dir > 0 ? [lowEnd, highEnd] : [highEnd, lowEnd];
      const cells: [number, number][] = [];
      for (let r = fl.r0; r < fl.r1; r++) for (let c = fl.c0; c < fl.c1; c++) cells.push([r, c]);
      stairs.push({
        floor: f, cells, bottom: foot, top: [head[0], y + rise, head[2]],
        yaw: fl.axis === 'x' ? (fl.dir > 0 ? 90 : -90) : (fl.dir > 0 ? 0 : 180), width: fl.width * s, steps,
      });
    }

    /**
     * The facade round one exterior opening: a run `len` long from `a0` along its wall line
     * (x when `alongX`), the line's center `mid` across it, `out` the outside's sign across.
     */
    const dressOpening = (kind: 'door' | 'arch' | 'window', alongX: boolean, a0: number, len: number, mid: number, out: 1 | -1, wallHi: number): void => {
      const face = mid + (out * s) / 2;
      const point = (along: number, across: number, h: number): V3 => (alongX ? [along, h, across] : [across, h, along]);
      const slab = (mb: MeshBuilder, b0: number, b1: number, c0: number, c1: number, lo: number, hi: number): void => {
        if (hi - lo <= 1e-6 || b1 - b0 <= 1e-6 || Math.abs(c1 - c0) <= 1e-6) return;
        const [p0, p1] = [Math.min(c0, c1), Math.max(c0, c1)];
        if (alongX) mb.box([b0, lo, p0], [b1, hi, p1], 1);
        else mb.box([p0, lo, b0], [p1, hi, b1], 1);
      };
      /** A thin sheet seen from both sides. */
      const sheet = (mb: MeshBuilder, corners: V3[]): void => {
        mb.polygon(corners);
        mb.polygon([...corners].reverse());
      };
      const glazed = kind === 'window';
      const applies = (on: OpeningSet): boolean => on === 'all' || (on === 'windows') === glazed;
      const sill = y + spec.windowSill;
      const head = Math.min(glazed ? sill + spec.windowHeight : kind === 'door' ? y + spec.doorHeight : wallHi, wallHi);
      const { mullions, shutters, awnings, balconies } = facade;
      if (mullions !== null && glazed && onLevel(mullions.levels)) {
        const bars = Math.max(0, Math.ceil(len / mullions.spacing - 1e-9) - 1);
        for (let i = 1; i <= bars; i++) {
          const b = a0 + (len * i) / (bars + 1);
          slab(dressing('mullion'), b - mullions.width / 2, b + mullions.width / 2, mid - MULLION_T / 2, mid + MULLION_T / 2, sill, head);
        }
      }
      if (shutters !== null && glazed && onLevel(shutters.levels)) {
        const leaf = (len / 2) * shutters.width;
        slab(dressing('shutter'), a0 - leaf, a0, face, face + out * SHUTTER_T, sill, head);
        slab(dressing('shutter'), a0 + len, a0 + len + leaf, face, face + out * SHUTTER_T, sill, head);
      }
      const w0 = a0 - BALCONY_OVERSAIL;
      const w1 = a0 + len + BALCONY_OVERSAIL;
      if (balconies !== null && applies(balconies.on) && onLevel(balconies.levels, true)) {
        const d = balconies.depth;
        const deck = part('balcony');
        slab(deck, w0, w1, face, face + out * d, y - BALCONY_T, y);
        if (balconies.rail > 0) {
          const rail = y + balconies.rail;
          slab(deck, w0, w1, face + out * (d - RAIL_T), face + out * d, y, rail);
          slab(deck, w0, w0 + RAIL_T, face, face + out * (d - RAIL_T), y, rail);
          slab(deck, w1 - RAIL_T, w1, face, face + out * (d - RAIL_T), y, rail);
        }
      }
      if (awnings !== null && applies(awnings.on) && onLevel(awnings.levels)) {
        const hi = Math.min(head + awnings.rise, wallHi);
        const lo = hi - awnings.drop;
        const reach = face + out * awnings.depth;
        const cloth = dressing('awning');
        sheet(cloth, [point(w0, face, hi), point(w1, face, hi), point(w1, reach, lo), point(w0, reach, lo)]);
        sheet(cloth, [point(w0, reach, lo), point(w1, reach, lo), point(w1, reach, lo - AWNING_VALANCE), point(w0, reach, lo - AWNING_VALANCE)]);
        // The cloth's thickness at its edges, so it isn't a line seen side on.
        sheet(cloth, [point(w0, face, hi), point(w0, reach, lo), point(w0, reach, lo - AWNING_T), point(w0, face, hi - AWNING_T)]);
        sheet(cloth, [point(w1, face, hi), point(w1, reach, lo), point(w1, reach, lo - AWNING_T), point(w1, face, hi - AWNING_T)]);
      }
    };

    // Openings: runs of one kind along their wall line.
    const done = new Set<string>();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const kind = g.kind(r, c);
        if ((kind !== 'door' && kind !== 'arch' && kind !== 'window') || done.has(`${r},${c}`)) continue;
        // The wall runs along x when the run's ends along x reach walls.
        const alongX = wallLikeRun(g, r, c, 0, 1);
        const [dr, dc] = alongX ? [0, 1] : [1, 0];
        let n = 0;
        while (g.kind(r + dr * n, c + dc * n) === kind) {
          done.add(`${r + dr * n},${c + dc * n}`);
          n++;
        }
        const cx = X(c) + (dc * n * s + (1 - dc) * s) / 2;
        const cz = Z(r) + (dr * n * s + (1 - dr) * s) / 2;
        // Across the wall: +z for a wall along x, +x for one along z; rooms on the - and + sides.
        const side = (sgn: number): string => {
          const rr = alongX ? r + sgn : r;
          const cc = alongX ? c : c + sgn;
          return g.kind(rr, cc) === 'room' ? roomOf.get(`${rr},${cc}`)! : g.kind(rr, cc) === 'void' ? 'outside' : 'wall';
        };
        openings.push({
          kind, floor: f, position: [cx, y, cz], yaw: alongX ? 0 : 90, width: n * s, rooms: [side(-1), side(1)],
        });
        if (kind === 'window') {
          const t = Math.min(0.04, s / 4);
          const lo = y + spec.windowSill;
          const hi = lo + spec.windowHeight;
          if (alongX) glass.box([X(c), lo, cz - t / 2], [X(c) + n * s, hi, cz + t / 2], 1);
          else glass.box([cx - t / 2, lo, Z(r)], [cx + t / 2, hi, Z(r) + n * s], 1);
        }
        const out = side(-1) === 'outside' ? -1 : side(1) === 'outside' ? 1 : 0;
        if (out !== 0) dressOpening(kind, alongX, alongX ? X(c) : Z(r), n * s, alongX ? cz : cx, out, wallTop(r, c));
      }
    }

    // Roof over every filled cell with nothing above (but the hatch over a flight onto it).
    const roofed = (r: number, c: number): boolean => filled(r, c) && !covered(r, c) && !(f === lastFloor && hatch.has(`${r},${c}`));
    const roof = spec.roof;
    if (roof.type === 'none') return;
    const heights = new Set<number>();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (roofed(r, c)) heights.add(cellTop(r, c));
    for (const h of [...heights].sort((a, b) => a - b)) {
      for (const [r0, c0, r1, c1] of rectangles(rows, cols, (r, c) => roofed(r, c) && cellTop(r, c) === h)) {
        if (roof.type === 'flat') {
          part('roof').box([X(c0), h, Z(r0)], [X(c1), h + spec.slab, Z(r1)], 1);
        } else {
          pitched(part('roof'), part('wall'), roof.type, X(c0), Z(r0), X(c1), Z(r1), h, roof.pitch, roof.overhang);
        }
      }
    }

    // Parapet over the exterior walls' deck (a wall cell with void among its 8 neighbours), capped by the coping.
    if (roof.type !== 'flat' || parapet <= 0) return;
    const edge = (r: number, c: number): boolean => {
      if (!roofed(r, c) || !wallLike(g.kind(r, c))) return false;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (open(r + dr, c + dc)) return true;
      return false;
    };
    const tops = new Set<number>();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (edge(r, c)) tops.add(cellTop(r, c));
    for (const h of [...tops].sort((a, b) => a - b)) {
      const lo = h + spec.slab;
      const hi = lo + parapet;
      const on = (r: number, c: number): boolean => edge(r, c) && cellTop(r, c) === h;
      for (const [r0, c0, r1, c1] of rectangles(rows, cols, on)) {
        part('wall').box([X(c0), lo, Z(r0)], [X(c1), hi, Z(r1)], 1);
        if (spec.roof.coping !== true) continue;
        // Oversail on the sides no other stretch of parapet continues from, so caps never overlap.
        const free = (cells: [number, number][]): boolean => cells.every(([r, c]) => !edge(r, c));
        const line = (a: number, b: number, at: (k: number) => [number, number]): [number, number][] => Array.from({ length: b - a }, (_, i) => at(a + i));
        const P = COPING_PROUD;
        const x0 = X(c0) - (free(line(r0, r1, (k) => [k, c0 - 1])) ? P : 0);
        const x1 = X(c1) + (free(line(r0, r1, (k) => [k, c1])) ? P : 0);
        const z0 = Z(r0) - (free(line(c0, c1, (k) => [r0 - 1, k])) ? P : 0);
        const z1 = Z(r1) + (free(line(c0, c1, (k) => [r1, k])) ? P : 0);
        part('coping').box([x0, hi, z0], [x1, hi + COPING_HEIGHT, z1], 1);
      }
    }
  });

  // Roof planes are shells: give them undersides so eaves and attics are closed from below.
  const roofPart = solid.get('roof');
  if (roofPart !== undefined && spec.roof.type !== 'flat') roofPart.append(roofPart.flipped());
  return { solid, trim, glass, glassWalls, navStairs, stairs, rooms, openings, footprint: [x0, z0, x0 + cols * s, z0 + rows * s] };
}

/**
 * A pitched roof over the wall rectangle [ax, bx] × [az, bz] whose wall tops are at `y`:
 * planes meet the wall line at `y` and run on `overhang` meters beyond it (dropping
 * below `y` at the eaves); gable ends (and a shed's high and side walls) fill the wall
 * line up to the roof, in `walls`.
 */
function pitched(roof: MeshBuilder, walls: MeshBuilder, type: 'gable' | 'hip' | 'shed', ax: number, az: number, bx: number, bz: number, y: number, pitch: number, o: number): void {
  const slope = Math.tan((pitch * Math.PI) / 180);
  const w = bx - ax;
  const d = bz - az;
  const ex0 = ax - o;
  const ex1 = bx + o;
  const ez0 = az - o;
  const ez1 = bz + o;
  const eave = y - o * slope;
  if (type === 'shed') {
    // Low along az, rising across z to the high wall at bz.
    const high = y + d * slope;
    const top = high + o * slope;
    roof.quad([ex0, eave, ez0], [ex0, top, ez1], [ex1, top, ez1], [ex1, eave, ez0], w + 2 * o, Math.hypot(d + 2 * o, (d + 2 * o) * slope));
    walls.polygon([[ax, y, az], [ax, y, bz], [ax, high, bz]]);
    walls.polygon([[bx, y, bz], [bx, y, az], [bx, high, bz]]);
    walls.quad([ax, y, bz], [bx, y, bz], [bx, high, bz], [ax, high, bz], w, high - y);
    return;
  }
  const alongX = w >= d;
  const half = (alongX ? d : w) / 2;
  const peak = y + half * slope;
  const run = Math.hypot(half + o, (half + o) * slope);
  if (type === 'gable') {
    if (alongX) {
      const mz = az + half;
      roof.quad([ex0, eave, ez0], [ex0, peak, mz], [ex1, peak, mz], [ex1, eave, ez0], w + 2 * o, run);
      roof.quad([ex1, eave, ez1], [ex1, peak, mz], [ex0, peak, mz], [ex0, eave, ez1], w + 2 * o, run);
      walls.polygon([[ax, y, az], [ax, y, bz], [ax, peak, mz]]);
      walls.polygon([[bx, y, bz], [bx, y, az], [bx, peak, mz]]);
    } else {
      const mx = ax + half;
      roof.quad([ex1, eave, ez0], [mx, peak, ez0], [mx, peak, ez1], [ex1, eave, ez1], d + 2 * o, run);
      roof.quad([ex0, eave, ez1], [mx, peak, ez1], [mx, peak, ez0], [ex0, eave, ez0], d + 2 * o, run);
      walls.polygon([[bx, y, az], [ax, y, az], [mx, peak, az]]);
      walls.polygon([[ax, y, bz], [bx, y, bz], [mx, peak, bz]]);
    }
    return;
  }
  // Hip: a ridge along the longer side, `half` in from the wall ends (a pyramid when square).
  if (alongX) {
    const mz = az + half;
    const r0 = ax + half;
    const r1 = bx - half;
    roof.polygon([[ex0, eave, ez0], [r0, peak, mz], [r1, peak, mz], [ex1, eave, ez0]]);
    roof.polygon([[ex1, eave, ez1], [r1, peak, mz], [r0, peak, mz], [ex0, eave, ez1]]);
    roof.polygon([[ex0, eave, ez1], [r0, peak, mz], [ex0, eave, ez0]]);
    roof.polygon([[ex1, eave, ez0], [r1, peak, mz], [ex1, eave, ez1]]);
  } else {
    const mx = ax + half;
    const r0 = az + half;
    const r1 = bz - half;
    roof.polygon([[ex1, eave, ez0], [mx, peak, r0], [mx, peak, r1], [ex1, eave, ez1]]);
    roof.polygon([[ex0, eave, ez1], [mx, peak, r1], [mx, peak, r0], [ex0, eave, ez0]]);
    roof.polygon([[ex0, eave, ez0], [mx, peak, r0], [ex1, eave, ez0]]);
    roof.polygon([[ex1, eave, ez1], [mx, peak, r1], [ex0, eave, ez1]]);
  }
}
