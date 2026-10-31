import { describe, expect, it } from 'vitest';
import { Vec3 } from '../../../core/index.js';
import type { ParallaxError, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { instantiate, Kernel } from '../../kernel/index.js';
import type { Fields, GameDefinition, KernelPlugin } from '../../kernel/index.js';
import { NAV_SERVICE, PROCGEN_SERVICE } from '../../services/index.js';
import { nav } from '../nav/index.js';
import { procgen, STRUCTURE, STRUCTURE_SCHEMA, structureSpec } from './index.js';
import type { GeneratedStair } from './index.js';
import { DEFAULT_STOREY, parsePlan, PLAN_CHARACTERS } from './plan.js';
import { buildStructure, problemSite, STAIR_MAX_PITCH, structureProblems } from './structure.js';
import type { StructureSpec } from './structure.js';

const BASE: Omit<StructureSpec, 'floors' | 'legend'> = {
  cell: 1, slab: 0.2, doorHeight: 2.2, windowSill: 0.9, windowHeight: 1.2, roof: { type: 'flat', pitch: 30, overhang: 0 },
};

/** A hall with a flight up to the landing above it. */
const TWO_STOREY: StructureSpec = {
  ...BASE,
  legend: {},
  floors: [
    { plan: ['####+####', '#hhhhhhh#', '#h>>>>>h#', '#hhhhhhh#', '#########'], height: 3 },
    { plan: ['#########', '#lllllll#', '#lllllll#', '#lllllll#', '#########'], height: 3 },
  ],
};

const topOf = (positions: readonly number[]): number => {
  let hi = -Infinity;
  for (let i = 1; i < positions.length; i += 3) hi = Math.max(hi, positions[i]!);
  return hi;
};

describe('structure stairs', () => {
  it('builds a solid flight that lands flush on the storey above, and leaves the stairwell open', () => {
    expect(structureProblems(TWO_STOREY)).toEqual([]);
    const g = buildStructure(TWO_STOREY);
    expect(g.stairs).toHaveLength(1);
    const st = g.stairs[0]!;
    expect(st.floor).toBe(0);
    expect(st.steps).toBe(17);
    // Climbs +x from the hall's west end; the head is 3 m up, 5 m further east.
    expect(st.yaw).toBe(90);
    expect(st.top[0] - st.bottom[0]).toBeCloseTo(5, 6);
    expect(st.top[1]).toBeCloseTo(3, 6);
    expect(st.width).toBe(1);
    const treads = g.solid.get('stair')!;
    expect(treads.triangleCount).toBe(17 * 12);
    expect(topOf(treads.positions)).toBeCloseTo(3, 6);
    // No slab of the upper storey crosses the flight's cells (x in [-2.5, 2.5], z in [-0.5, 0.5]) at y ≈ 3.
    const slab = g.solid.get('slab')!.positions;
    for (let i = 0; i < slab.length; i += 3) {
      const [x, y, z] = [slab[i]!, slab[i + 1]!, slab[i + 2]!];
      if (y > 2.7 && y < 3.1) expect(x > -2.5 + 1e-6 && x < 2.5 - 1e-6 && z > -0.5 + 1e-6 && z < 0.5 - 1e-6).toBe(false);
    }
    // The landing's center is not over the hole.
    const landing = g.rooms.find((r) => r.floor === 1)!;
    expect(Math.abs(landing.center[2]) > 0.5 || Math.abs(landing.center[0]) > 2.5).toBe(true);
  });

  it('climbs the way its arrow points, nothing inferred', () => {
    const spec: StructureSpec = {
      ...TWO_STOREY,
      floors: [
        { plan: ['####+#####', '#hhhhhhhh#', '#h#<<<<hh#', '#hhhhhhhh#', '##########'], height: 3 },
        { plan: ['##########', '#llllllll#', '#llllllll#', '#llllllll#', '##########'], height: 3 },
      ],
    };
    // `<` climbs west: its foot open to the east, its head over the wall at the west end.
    const problems = structureProblems(spec);
    expect(problems).toEqual([]);
    const st = buildStructure(spec).stairs[0]!;
    expect(st.yaw).toBe(-90);
    expect(st.top[0]).toBeLessThan(st.bottom[0]);
    // `^` climbs up the page (+z), `v` down it, whatever the flight's shape.
    const along = (arrow: string): number => buildStructure({
      ...TWO_STOREY,
      floors: [
        { plan: ['#######', '#hhhhh#', `#h${arrow}${arrow}${arrow}h#`, `#h${arrow}${arrow}${arrow}h#`, `#h${arrow}${arrow}${arrow}h#`, '#hhhhh#', '#######'], height: 3 },
        { plan: ['#######', '#lllll#', '#lllll#', '#lllll#', '#lllll#', '#lllll#', '#######'], height: 3 },
      ],
    }).stairs[0]!.yaw;
    expect([along('>'), along('<'), along('^'), along('v')]).toEqual([90, -90, 0, 180]);
    // Pointing into a wall leaves no room at the foot: the arrow is never second-guessed.
    const backwards = structureProblems({ ...spec, floors: [{ ...spec.floors[0]!, plan: ['####+#####', '#hhhhhhhh#', '#h#>>>>hh#', '#hhhhhhhh#', '##########'] }, spec.floors[1]!] });
    expect(backwards.map((p) => p.message)).toContain('the stair run has no room cell at its foot to step on from');
  });

  it('the old guessed-direction stairs and ^ arches are errors that say what to write now', () => {
    const old = structureProblems({ ...TWO_STOREY, floors: [{ ...TWO_STOREY.floors[0]!, plan: ['####+####', '#hhhhhhh#', '#h/////h#', '#hhhhhhh#', '#########'] }, TWO_STOREY.floors[1]!] });
    expect(old).toHaveLength(1);
    expect(old[0]!.message).toBe('"/" is no longer a plan character');
    expect(old[0]!.fix).toContain('> (+x)');
    const arch = structureProblems({ ...BASE, legend: {}, floors: [{ plan: ['#####', '#hhh#', '##^##'], height: 3 }] });
    expect(arch.map((p) => p.fix)).toContain('Arches are _ now (^ climbs up the page); write this opening as _.');
    expect(structureProblems({ ...BASE, legend: {}, floors: [{ plan: ['#####', '#hhh#', '##_##'], height: 3 }] })).toEqual([]);
  });

  it('reports flights that cannot be walked', () => {
    const steep: StructureSpec = { ...TWO_STOREY, floors: [{ ...TWO_STOREY.floors[0]!, plan: ['##+##', '#h>h#', '#####'] }, { plan: ['#####', '#lll#', '#####'], height: 3 }] };
    const messages = structureProblems(steep).map((p) => p.message);
    expect(messages.some((m) => m.includes('a ladder'))).toBe(true);
    expect(STAIR_MAX_PITCH).toBe(50);
    const top = structureProblems({ ...TWO_STOREY, floors: [TWO_STOREY.floors[0]!] });
    expect(top.map((p) => p.message)).toContain('the stair run is on the top floor: there is nothing to climb to');
    const capped = structureProblems({
      ...TWO_STOREY,
      floors: [TWO_STOREY.floors[0]!, { plan: ['#########', '#lllllll#', '##########', '#lllllll#', '#########'], height: 3 }],
    });
    expect(capped.some((p) => p.message.includes('not open room over the stair run'))).toBe(true);
    const odd = structureProblems({ ...TWO_STOREY, floors: [{ plan: ['###+###', '#h>>>h#', '#h>>hh#', '#######'], height: 3 }, TWO_STOREY.floors[1]!] });
    expect(odd.some((p) => p.message === 'the stair run of > is not a rectangle')).toBe(true);
  });
});

describe('structure glass walls and room heights', () => {
  it('glass walls are thin panes along the wall line, closing it for openings', () => {
    const spec: StructureSpec = {
      ...BASE, legend: {},
      floors: [{ plan: ['#|+|#', '#sss#', '#|||#'], height: 3 }],
    };
    expect(structureProblems(spec)).toEqual([]);
    const g = buildStructure(spec);
    const pane = g.glassWalls.build();
    // Two runs: the back (three cells, merged) and the front's two single panes, 5 cm thick.
    expect(pane.indices.length / 3).toBe(3 * 12);
    expect(pane.max[1]).toBeCloseTo(3, 6);
    expect(pane.max[0] - pane.min[0]).toBeCloseTo(3, 6);
    expect(g.solid.get('wall')!.triangleCount).toBeGreaterThan(0);
    expect(g.openings.map((o) => o.kind)).toEqual(['door']);
  });

  it('a room height steps its walls and roof; a tall room needs void above', () => {
    const spec: StructureSpec = {
      ...BASE,
      legend: { a: { name: 'annex', floor: 'floor', height: 2.4 }, h: { name: 'hall', floor: 'floor' } },
      floors: [{ plan: ['#######', '#aa+hh#', '#aa#hh#', '#######'], height: 3.2 }],
    };
    expect(structureProblems(spec)).toEqual([]);
    const g = buildStructure(spec);
    const roof = g.solid.get('roof')!.positions;
    const ys = new Set<number>();
    for (let i = 1; i < roof.length; i += 3) ys.add(Math.round(roof[i]! * 100) / 100);
    // Annex roof at 2.4 (+ slab), the hall's and the shared wall's at 3.2.
    expect([...ys].sort((a, b) => a - b)).toEqual([2.4, 2.6, 3.2, 3.4]);
    const tall: StructureSpec = {
      ...spec,
      legend: { h: { name: 'hall', floor: 'floor', height: 6 } },
      floors: [spec.floors[0]!, { plan: ['#######', '#aa#hh#', '#aa#hh#', '#######'], height: 3 }],
    };
    const problems = structureProblems(tall);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('floor 1 builds over it');
    const hall: StructureSpec = { ...tall, floors: [spec.floors[0]!, { plan: ['####...', '#aa#...', '#aa#...', '####...'], height: 3 }] };
    expect(structureProblems(hall)).toEqual([]);
    // The hall's walls rise 6 m from the ground (the storey above, from 3.2 m, stops at 6.2).
    const walls = buildStructure(hall).solid.get('wall')!.positions;
    let hallTop = -Infinity;
    for (let i = 0; i < walls.length; i += 3) if (walls[i]! > 0.5) hallTop = Math.max(hallTop, walls[i + 1]!);
    expect(hallTop).toBeCloseTo(6, 6);
  });
});

describe('structure in the plugin', () => {
  it('serves solid glass walls and stairs, and answers stairs() in world space', () => {
    const scene = {
      mode: '3d',
      entities: [{
        id: 'house', prefab: 'empty', at: [10, 0, 0],
        components: {
          structure: {
            floors: [
              { plan: ['##||+||##', '#hhhhhhh#', '#h>>>>>h#', '#hhhhhhh#', '#########'] },
              { plan: ['#########', '#lllllll#', '#lllllll#', '#lllllll#', '#########'] },
            ],
            legend: { h: { name: 'hall', height: 2.8 } },
            materials: { glass: { color: [0.6, 0.8, 0.9, 0.3] } },
          },
        },
      }],
    };
    const text: Record<string, string> = { 'prefabs/empty.prefab.json': '{"components": {}}', 'scenes/s/scene.json': JSON.stringify(scene) };
    const files: ProjectFiles = { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
    const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
    const kernel = new Kernel({ project: loadProject(files), game, plugins: [procgen()] });
    kernel.start('s');
    const [mesh] = kernel.service(PROCGEN_SERVICE).meshes();
    const ids = mesh!.parts.map((p) => p.geometry.id);
    expect(ids.length).toBeGreaterThan(4);
    const glassWall = mesh!.parts.find((p) => p.material.id.startsWith('procgen|structure:glass_wall|'))!;
    expect(glassWall.material.blend).toBe(true);
    // Every part collides (no windows here), the glass walls included.
    const vertices = mesh!.parts.reduce((n, p) => n + p.geometry.positions.length, 0);
    expect(mesh!.collision!.vertices.length).toBe(vertices);
    const [, structure] = kernel.world.query(['structure'])[0]! as [never, Fields & Record<string, (...a: unknown[]) => unknown>];
    const [stair] = structure['stairs']!() as GeneratedStair[];
    expect(stair!.floor).toBe(0);
    expect(stair!.bottom.x).toBeCloseTo(10 - 2.5, 6);
    expect(stair!.top.y).toBeCloseTo(3, 6);
    expect(stair!.yaw).toBeCloseTo(90, 6);
  });
});

// ── Plan files, roofs you can stand on, facades, and change tracking ────────────

/** A two-storey shophouse at 0.5 m cells: a flight up the west (-x) side, a flight onto the roof across the north (+z) end. */
const SHOP_PLAN = `--- 3.4
##################
+SSSSSSSSSSSSSSSS#
+SSSSSSSSSSSSSSSS#
+SSSSSSSSSSSSSSSS#
#^^^SSSSSSSSSSSSS=
#^^^SSSSSSSSSSSSS=
#^^^SSSSSSSSSSSSS=
#^^^SSSSSSSSSSSSS#
#^^^SSSSSSSSSSSSS+
#^^^SSSSSSSSSSSSS+
#^^^SSSSSSSSSSSSS+
#^^^SSSSSSSSSSSSS+
#^^^SSSSSSSSSSSSS#
#^^^SSSSSSSSSSSSS#
#SSSSSSSSSSSSSSSS#
#SSSSSSSSSSSSSSSS=
#SSSSSSSSSSSSSSSS=
#SSSSSSSSSSSSSSSS=
#SSSSSSSSSSSSSSSS#
##################
--- 3.4
##################
#UUUUUUUUUUUUUUUU=
#UUU>>>>>>>>>>UUU=
#UUU>>>>>>>>>>UUU#
#UUU>>>>>>>>>>UUU#
#UUUUUUUUUUUUUUUU#
#UUUUUUUUUUUUUUUU#
#UUUUUUUUUUUUUUUU#
#UUUUUUUUUUUUUUUU#
#UUUUUUUUUUUUUUUU#
=UUUUUUUUUUUUUUUU#
=UUUUUUUUUUUUUUUU#
#UUUUUUUUUUUUUUUU#
#UUUUUUUUUUUUUUUU#
#UUUUUUUUUUUUUUUU#
#UUUUUUUUUUUUUUUU#
#UUUUUUUUUUUUUUUU=
#UUUUUUUUUUUUUUUU=
#UUUUUUUUUUUUUUUU#
##################
--- legend
S shop tile
U upper boards
`;

const SHOP_STYLE = {
  plan: 'buildings/shop.plan', cell: 0.5, door_height: 2.1,
  roof: { kind: 'flat', access: true, parapet: 0.75, coping: true },
  facade: { plinth: 0.55, mullions: {}, shutters: { levels: [1] }, awnings: { levels: [0], depth: 1.2 } },
  materials: { wall: { color: '#efe4cf' } },
};

function kernelWith(entities: unknown[], extra: Record<string, string> = {}, plugins: KernelPlugin[] = []): { kernel: Kernel; plugin: ReturnType<typeof procgen> } {
  const text: Record<string, string> = {
    'prefabs/empty.prefab.json': '{"components": {}}', 'prefabs/shophouse.prefab.json': JSON.stringify({ components: { structure: SHOP_STYLE } }),
    'buildings/shop.plan': SHOP_PLAN, 'scenes/s/scene.json': JSON.stringify({ entities }), ...extra,
  };
  const files: ProjectFiles = { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
  const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
  const plugin = procgen();
  const kernel = new Kernel({ project: loadProject(files), game, plugins: [plugin, ...plugins] });
  kernel.start('s');
  return { kernel, plugin };
}

describe('structure plan files', () => {
  it('parses storeys, heights, a legend and every row\'s line', () => {
    const p = parsePlan(SHOP_PLAN);
    expect(p.problems).toEqual([]);
    expect(p.floors.map((f) => [f.plan.length, f.height])).toEqual([[20, 3.4], [20, 3.4]]);
    expect(p.floors[1]!.lines[0]).toBe(23);
    expect(p.legend['S']).toEqual({ name: 'shop', floor: 'tile', height: null });
    const bad = parsePlan('--- tall\n###\n#a#\n###\n--- legend\nab shop\n');
    expect(bad.problems.map((q) => [q.line, q.column])).toEqual([[1, 5], [6, 1]]);
    expect(parsePlan('###\n#a#\n###').floors[0]!.height).toBe(DEFAULT_STOREY);
  });

  it('a placement names its plan over a style prefab; problems point at the file', () => {
    const { kernel } = kernelWith([{ prefab: 'shophouse', components: { structure: { colors: { wall: '#d9b8b0' } } } }]);
    const [mesh] = kernel.service(PROCGEN_SERVICE).meshes();
    const wall = mesh!.parts.find((part) => part.material.id.startsWith('procgen|structure:wall|'))!;
    expect(wall.material.color[0]).toBeCloseTo(0xd9 / 255, 3);
    // "slab" isn't given: it falls back to the wall's material (and colour).
    expect(mesh!.parts.find((part) => part.material.id.startsWith('procgen|structure:slab|'))!.material.color[0]).toBeCloseTo(0xd9 / 255, 3);
    const spec = structureSpec(instantiate(STRUCTURE_SCHEMA, { ...SHOP_STYLE, facade: {}, plan: 'buildings/bad.plan' } as never, 's'), 's', new Map([['buildings/bad.plan', '--- 3\n#####\n#a?a#\n#####\n']]));
    const [problem] = structureProblems(spec);
    expect(spec.source!.rows[problem!.floor]![problem!.row]).toBe(3);
    expect(problem!.column).toBe(2);
    // The runtime and `parallax check` both name the file, line and 1-based column.
    expect(problemSite(spec, problem!)).toEqual({ text: 'buildings/bad.plan line 3, column 3 (floor 0)', path: 'buildings/bad.plan', line: 3 });
    expect(problemSite({ ...spec, source: undefined }, problem!).text).toBe('floor 0 row 1 column 2');
  });

  it('a legend may not restyle a reserved plan character', () => {
    const p = parsePlan('--- 3\n#####\n#a>a#\n#####\n--- legend\n> ramp\n_ hall\nv vault\n');
    expect(p.problems.map((q) => [q.line, q.message])).toEqual([
      [6, 'legend entry ">" names a reserved plan character (stairs climbing towards +x)'],
      [7, 'legend entry "_" names a reserved plan character (arch (an opening as tall as the wall, no door))'],
      [8, 'legend entry "v" names a reserved plan character (stairs climbing towards -z (down the page))'],
    ]);
    expect(p.problems[0]!.fix).toContain('> stairs climbing towards +x');
    const inline = (): unknown => structureSpec(instantiate(STRUCTURE_SCHEMA, { floors: [{ plan: ['###', '#a#', '###'] }], legend: { '#': { name: 'x' } } } as never, 's'), 's');
    expect(inline).toThrow(/reserved plan character/);
    // Every reserved character is in the one table, and the stub's list matches it.
    expect(PLAN_CHARACTERS.map((c) => c.char).join('')).toBe('#|+_=><^v. ');
  });

  it('a mistyped material key is a coded error with a suggestion; a missing plan file too', () => {
    const read = (fields: Record<string, unknown>): ParallaxError => {
      try {
        structureSpec(instantiate(STRUCTURE_SCHEMA, fields as never, 's'), 's', new Map([['buildings/shop.plan', SHOP_PLAN]]));
      } catch (e) { return e as ParallaxError; }
      throw new Error('no error');
    };
    const typo = read({ ...SHOP_STYLE, materials: { plinht: {} } });
    expect(typo.diagnostic.code).toBe('PP3652');
    expect(typo.diagnostic.fix).toContain('"plinth"');
    expect(read({ ...SHOP_STYLE, plan: 'buildings/shp.plan' }).diagnostic.code).toBe('PP3653');
  });
});

describe('structure roofs and facades', () => {
  const shop = (): StructureSpec => {
    const p = parsePlan(SHOP_PLAN);
    return {
      ...BASE, cell: 0.5, doorHeight: 2.1, legend: p.legend, floors: p.floors.map((f) => ({ plan: f.plan, height: f.height })),
      roof: { type: 'flat', pitch: 30, overhang: 0, access: true, parapet: 0.75, coping: true },
      plinth: 0.55,
      facade: {
        shutters: { width: 0.5, levels: [1] }, mullions: { spacing: 1.2, width: 0.06, levels: null },
        awnings: { on: 'windows', depth: 1.2, drop: 0.25, rise: 0.15, levels: [0] }, balconies: null,
      },
    };
  };

  it('a top-floor flight climbs onto the roof deck through a hatch, behind a capped parapet', () => {
    expect(structureProblems(shop())).toEqual([]);
    expect(structureProblems({ ...shop(), roof: { ...shop().roof, access: false } }).map((p) => p.message))
      .toContain('the stair run is on the top floor: there is nothing to climb to');
    const g = buildStructure(shop());
    const roofFlight = g.stairs.find((st) => st.floor === 1)!;
    // 3.4 m storey + the 0.2 m deck: 6.8 + 0.2 = 7.0 above the ground floor.
    expect(roofFlight.top[1]).toBeCloseTo(7, 6);
    expect(roofFlight.yaw).toBe(90);
    const deck = g.solid.get('roof')!.positions;
    for (let i = 0; i < deck.length; i += 3) {
      // Nothing of the deck over the flight (x -2.5..2.5, z 2.5..4).
      const [x, z] = [deck[i]!, deck[i + 2]!];
      expect(x > -2.5 + 1e-6 && x < 2.5 - 1e-6 && z > 2.5 + 1e-6 && z < 4 - 1e-6).toBe(false);
    }
    expect(topOf(g.solid.get('wall')!.positions)).toBeCloseTo(7 + 0.75, 6);
    expect(topOf(g.solid.get('coping')!.positions)).toBeCloseTo(7 + 0.75 + 0.08, 6);
  });

  it('plinth, mullions, shutters and awnings go on the outside, by storey; only the plinth is solid', () => {
    const g = buildStructure(shop());
    const plinth = g.solid.get('plinth')!.build();
    expect(plinth.max[1]).toBeCloseTo(0.55, 6);
    expect(plinth.min[0]).toBeCloseTo(-4.5 - 0.05, 6);
    // Windows: east face rows 4-6 and 15-17 (ground), rows 16-17 west... mullions: one bar in each 1.5 m window.
    const bars = g.trim.get('mullion')!.triangleCount / 12;
    expect(bars).toBe(2);
    // Shutters on floor 1's three windows: two leaves each.
    expect(g.trim.get('shutter')!.triangleCount / 12).toBe(6);
    expect(g.trim.get('awning')!.build().max[1]).toBeLessThan(3.4);
    expect(g.solid.has('shutter')).toBe(false);
    // An upper-floor door onto the street needs a balcony.
    const flats: StructureSpec = { ...shop(), floors: [shop().floors[0]!, { ...shop().floors[1]!, plan: shop().floors[1]!.plan.map((r, i) => (i === 10 ? `${r.slice(0, 17)}+` : r)) }] };
    expect(structureProblems(flats).some((p) => p.message.includes('opens onto a 3.4 m drop'))).toBe(true);
    expect(structureProblems({ ...flats, facade: { ...flats.facade!, balconies: { on: 'doors', depth: 1, rail: 0.95, levels: null } } })).toEqual([]);
    const balcony = buildStructure({ ...flats, facade: { ...flats.facade!, balconies: { on: 'doors', depth: 1, rail: 0.95, levels: null } } }).solid.get('balcony')!.build();
    expect(balcony.max[0]).toBeCloseTo(4.5 + 1, 6);
  });

  it('nav agents of radius 0.5 path from the street up both flights onto the roof', () => {
    const { kernel } = kernelWith([{ prefab: 'shophouse', at: [0, 0.05, 0] }], {}, [nav({ agentRadius: 0.5 })]);
    const n = kernel.service(NAV_SERVICE);
    const route = (a: Vec3, b: Vec3) => n.path(a, b, 0.5);
    const upper = route(new Vec3(7, 0, 0), new Vec3(0, 3.45, -2));
    expect(upper!.length).toBeGreaterThan(2);
    expect(upper![upper!.length - 1]!.y).toBeCloseTo(3.45, 1);
    const roof = route(new Vec3(7, 0, 0), new Vec3(0, 7.05, -2));
    expect(roof![roof!.length - 1]!.y).toBeCloseTo(7.05, 1);
  });
});

describe('procgen change tracking', () => {
  it('perf: physics steps and nav queries over ten structures rebuild and re-key nothing until a structure changes', () => {
    const entities = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, prefab: 'shophouse', at: [i * 20, 0.05, 0] }));
    const { kernel, plugin } = kernelWith(entities, {}, [nav({ agentRadius: 0.5 })]);
    const service = kernel.service(PROCGEN_SERVICE);
    const n = kernel.service(NAV_SERVICE);
    const first = service.meshes();
    expect(first).toHaveLength(10);
    const { keyed, builds } = plugin.stats();
    for (let frame = 0; frame < 120; frame++) {
      kernel.step(1 / 60);
      for (let q = 0; q < 5; q++) n.lineClear(new Vec3(-10, 1, 3), new Vec3(200, 1, 3), []);
      expect(service.meshes()).toBe(first);
    }
    expect(plugin.stats()).toEqual({ keyed, builds });
    // Assigning a field rebuilds at once; an edit inside a value within a few frames.
    const [, fields] = kernel.world.query([STRUCTURE])[0]! as [never, Fields];
    fields['door_height'] = 2.0;
    const after = service.meshes();
    expect(after).not.toBe(first);
    expect(plugin.stats().builds).toBe(builds + 1);
    (fields['materials'] as Record<string, Fields>)['wall']!['roughness'] = 0.5;
    for (let frame = 0; frame < 4; frame++) kernel.step(1 / 60);
    expect(plugin.stats().builds).toBe(builds + 2);
  });

  it('a reload builds nothing it already built (content cache)', () => {
    const entities = [{ prefab: 'shophouse', at: [0, 0.05, 0], components: { structure: { colors: { wall: '#123456' } } } }];
    const a = kernelWith(entities);
    expect(a.kernel.service(PROCGEN_SERVICE).meshes()).toHaveLength(1);
    const b = kernelWith(entities);
    const [mesh] = b.kernel.service(PROCGEN_SERVICE).meshes();
    expect(b.plugin.stats().builds).toBe(0);
    expect(mesh!.version).toBe(a.kernel.service(PROCGEN_SERVICE).meshes()[0]!.version);
  });
});
