import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec2, Vec3 } from '../core/index.js';
import type { Placement, PrefabDoc, Project, SceneDoc } from '../resource/index.js';
import { Kernel, t } from '../function/kernel/index.js';
import type { GameDefinition, KernelPlugin } from '../function/kernel/index.js';
import { parseTree } from '../function/plugins/ai/index.js';
import {
  ai, AiApi, Brain, Check, Consider, Cooldown, Director, Do, Guard, MoveTo, Option, Plan, Perception, Random, Repeat, RUNNING,
  Selector, Sequence, SetValue, Spotted, Step, SUCCESS, Subtree, Task, TaskAgent, Tree, Utility, Wait,
} from './ai.js';
import { kw } from './kwargs.js';
import { nav } from './nav.js';
import { dict_of } from './pyrt/index.js';

const SIDE = { id: 'side', schema: { side: { type: { kind: 'tag' as const } } } };
const COLLIDER = { id: 'collider', schema: { shape: t.string({ default: 'box' }), offset: t.vec3({ default: Vec3.ZERO }), trigger: t.bool({ default: false }) } };

function run(plugins: KernelPlugin[], entities: Placement[]): { kernel: Kernel; ns: Record<string, unknown> } {
  const scene: SceneDoc = { id: 's', path: 'scenes/s/scene.json', tags: [], ui: [], init: {}, entities, regions: new Map(), plugins: {} };
  const project: Project = {
    prefabs: new Map<string, PrefabDoc>([['npc', {
      id: 'npc', feature: undefined, path: 'prefabs/npc.prefab.json', tags: [], behaviors: [], children: [],
      components: { side: { side: 'red' }, brain: { tree: 'guard' }, nav_agent: { speed: 4 }, perception: { notice_time: 0 } },
    }], ['hero', {
      id: 'hero', feature: undefined, path: 'prefabs/hero.prefab.json', tags: [], behaviors: [], children: [], components: { side: { side: 'blue' } },
    }]]),
    scenes: new Map([[scene.id, scene]]), config: new Map(), content: new Map(), locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  };
  const game: GameDefinition = { components: [SIDE, COLLIDER], resources: [], events: [], behaviors: [], systems: [] };
  const kernel = new Kernel({ project, game, plugins, context: { me: 'ctx' } });
  kernel.start('s');
  const ns: Record<string, unknown> = {};
  for (const p of plugins) if (p.namespace !== undefined) ns[p.namespace.name] = p.namespace.create(kernel);
  return { kernel, ns };
}

const place = (prefab: string, at: number[]): Placement => ({ prefab, at, components: {}, tags: [], params: {}, origin: { path: 'x', pointer: '' } });

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

describe('parallax.ai node constructors', () => {
  it('build the same documents as content trees', () => {
    const root = Selector(
      Guard(Check('target_visible'), Sequence(MoveTo('target', kw({ stopping_distance: 3 })), Do('shoot', kw({ spread: 2, name: 'fire' })), kw({ name: 'combat' }))),
      Utility(
        Option(Do('flee'), Consider('health', 'inverse', 0, 100)),
        Option(Do('wander'), kw({ base: 0.3 })),
      ),
      Plan(dict_of(['fed', true]), Step('eat', Do('eat'), kw({ effects: dict_of(['fed', true]), pre: dict_of(['food', dict_of(['op', '>', 'value', 0])]) }))),
      Repeat(Sequence(Wait([1, 2]), Random(SetValue('mood', 'calm'), SetValue('mood', 'bored'), kw({ weights: [2, 1] })), Cooldown(Subtree('idle'), 3))),
      kw({ memory: false }),
    );
    expect(root['type']).toBe('selector');
    expect((root['children'] as Record<string, unknown>[])[0]).toEqual({
      type: 'guard', if: { key: 'target_visible' },
      child: { type: 'sequence', name: 'combat', children: [{ type: 'move_to', key: 'target', stopping_distance: 3 }, { type: 'do', task: 'shoot', args: { spread: 2 }, name: 'fire' }] },
    });
    const { tree, diagnostics } = parseTree('g', { root }, { tree: (id) => (id === 'idle' ? { root: Wait(1) } : undefined) });
    expect(diagnostics).toEqual([]);
    expect([...tree!.tasks].sort()).toEqual(['eat', 'flee', 'shoot', 'wander']);
    expect(code(() => Guard(Do('x'), Do('y')))).toBe('PP3252');
    expect(code(() => Check())).toBe('PP3030');
  });
});

describe('ai() and ctx.ai', () => {
  it('runs Python tasks with an agent; status constants and booleans; kwargs checked', () => {
    const calls: string[] = [];
    const guard = new Tree('guard', Selector(Sequence(Check('target_visible'), Do('shoot', kw({ rounds: 3 }))), Do('patrol')), kw({ tick: 0 }));
    const plugin = ai(kw({
      trees: [guard],
      tasks: [
        new Task('shoot', (ctx: unknown, agent: TaskAgent) => {
          calls.push(`shoot ${String(agent.arg('rounds'))} ${String(agent.arg('missing', 'd'))} ${String((ctx as { me: string }).me)}`);
          agent.blackboard.set('shots', (agent.blackboard.get('shots', 0) as number) + 1);
          return SUCCESS;
        }),
        new Task('patrol', () => { calls.push('patrol'); return RUNNING; }, kw({ stop: () => { calls.push('stop patrol'); } })),
      ],
    }));
    const { kernel, ns } = run([nav(), plugin], [place('npc', [0, 0, 0]), place('hero', [0, 0, 40])]);
    const api = ns['ai'] as AiApi;
    expect(api).toBeInstanceOf(AiApi);
    const [npc] = [...kernel.world.live()].filter((r) => r.prefab === 'npc').map((r) => r.id);
    const [hero] = [...kernel.world.live()].filter((r) => r.prefab === 'hero').map((r) => r.id);
    kernel.step(1 / 60);
    expect(calls).toEqual(['patrol']);
    kernel.world.require(hero!).transform.setWorldPosition(new Vec3(0, 0, 5));
    for (let i = 0; i < 20; i++) kernel.step(1 / 60);
    expect(calls).toContain('stop patrol');
    expect(calls).toContain('shoot 3 d ctx');
    const brain = kernel.world.require(npc!).components.get('brain') as unknown as { blackboard: { get(k: string): unknown }; describe(): string };
    expect(brain.blackboard.get('shots')).toBeGreaterThan(0);
    expect(brain.describe()).toContain('shoot');
    expect(Brain.__component_id__).toBe('brain');
    expect(Perception.__component_id__).toBe('perception');
    expect(Spotted.__event_id__).toBe('spotted');
    // ctx.ai checks its arguments.
    expect(code(() => api.noise(new Vec2(1, 1)))).toBe('PP3291');
    expect(code(() => api.noise(new Vec3(0, 0, 0), kw({ loud: 3 })))).toBe('PP3030');
    expect(code(() => api.command([npc], 'charge', new Vec3(1, 0, 1)))).toBe('PP3275');
    expect(code(() => api.formation(new Vec3(0, 0, 0), new Vec3(0, 0, 1), 3, kw({ shape: 'blob' })))).toBe('PP3270');
    expect(api.formation(new Vec3(0, 0, 0), new Vec3(0, 0, 1), 3, kw({ shape: 'line', spacing: 1 }))).toEqual([new Vec3(-1, 0, 0), new Vec3(0, 0, 0), new Vec3(1, 0, 0)]);
  });

  it('rejects bad plugin arguments and task results', () => {
    expect(code(() => ai(kw({ tasks: [() => 1] })))).toBe('PP3253');
    expect(code(() => new Director(kw({ peak_intensity: 2 })))).toBe('PP3280');
    expect(code(() => new Director(kw({ budget: 2 })))).toBe('PP3280');
    expect(code(() => new Task('x'))).toBe('PP3030');
    const plugin = ai(kw({ trees: [new Tree('guard', Do('bad'), kw({ tick: 0 }))], tasks: [new Task('bad', () => 3)] }));
    const { kernel } = run([nav(), plugin], [place('npc', [0, 0, 0])]);
    expect(code(() => kernel.step(1 / 60))).toBe('PP3253');
  });
});
