import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { Json, Project } from '../../../resource/index.js';
import { Kernel, KERNEL_EVENTS, t } from '../../kernel/index.js';
import type { EventDef, Fields, GameDefinition, LogicInstance, SystemDef } from '../../kernel/index.js';
import { SAVE_SERVICE } from '../../services/index.js';
import type { SaveSection } from '../../services/index.js';
import { DIALOGUE_INPUT_SERVICE, story, STORY_EVENTS, STORY_SERVICE } from './index.js';
import type { DialogueSource, QuestVerbDecl, StoryEngine, StoryHost } from './index.js';

const DT = 1 / 60;
const DIED: EventDef = { id: 'died', target: 'entity' };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ParallaxError ? error.diagnostic.code : `not a ParallaxError: ${String(error)}`;
  }
  return undefined;
}

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const QUESTS = {
  errand: {
    title: 'Errand', summary: 'Do it.', start: 'meet',
    steps: {
      meet: { text: 'Meet the elder', verb: 'talk', target: 'elder', next: ['hunt'], sets: ['met'] },
      hunt: { text: 'Defeat 2 wolves', verb: 'defeat', target: 'wolf', count: 2, next: ['load'] },
      load: { text: 'Load', verb: 'hold', next: ['deliver'], next_if: [{ fact: 'rushed', goto: ['escape'] }] },
      escape: { text: 'Escape', verb: 'wait', count: 0.5, next: ['deliver'] },
      deliver: { text: 'Deliver', verb: 'deliver', target: 'mill', marker: 'mill' },
    },
  },
  scout: {
    title: 'Scout', summary: 'Look.', start: 'go',
    steps: {
      go: { text: 'Reach the mill', verb: 'reach', target: 'mill', next: ['gold'] },
      gold: { text: 'Gather 3 gold', verb: 'fact', target: 'gold', count: 3 },
    },
  },
};

const ELDER = [
  'title: start',
  '---',
  '<<if not $met>>',
  'Elder: Welcome, {$name}. #line:hello',
  '<<else>>',
  'Elder: Again?',
  '<<endif>>',
  '-> Ask for gold',
  '    <<set $gold to $gold + 2>>',
  '    <<pay 5 "coins">>',
  '-> Leave <<if $met>>',
  '    <<jump bye>>',
  'Elder: Off you go. #voice:elder_bye',
  '===',
  'title: bye',
  '---',
  '<<wait 0.1>>',
  'Elder: Bye.',
  '===',
].join('\n');

interface Setup {
  readonly kernel: Kernel;
  readonly engine: StoryEngine;
  readonly events: [string, Fields][];
  readonly host: { panel: number; commands: [string, Json[]][]; outcome: boolean | string; holdCalls: number; voices: string[] };
  readonly id: (placed: string) => EntityId;
  steps(n: number): void;
  press(): void;
  sections: SaveSection[];
}

function setup(options: { dialogues?: Record<string, string>; save?: boolean; quests?: Record<string, unknown>; badVerb?: boolean } = {}): Setup {
  const loaded = loadProject(files({
    'prefabs/wolf.prefab.json': { components: {} },
    'prefabs/person.prefab.json': { components: {} },
    'prefabs/eye.prefab.json': { components: { camera: {} } },
    'scenes/main/scene.json': {
      entities: [
        { prefab: 'person', id: 'elder', at: [0, 0, 0] },
        { prefab: 'person', id: 'hero', at: [50, 0, 50] },
        { prefab: 'person', id: 'mill', at: [5, 0, 5] },
        { prefab: 'eye', id: 'eye' },
        { prefab: 'wolf', at: [9, 0, 9] },
        { prefab: 'wolf', at: [9, 0, 10] },
      ],
    },
    'scenes/main/world.json': { cell_size: 64, layers: {} },
    'scenes/main/regions/mill/region.json': { bounds: { min: [0, 0], max: [10, 10] } },
    ...Object.fromEntries(Object.entries(options.quests ?? QUESTS).map(([id, q]) => [`content/quest/${id}.json`, q])),
  }));
  expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const dialogues = new Map<string, DialogueSource>(Object.entries(options.dialogues ?? { elder: ELDER })
    .map(([id, text]) => [id, { id, path: `story/${id}.yarn`, text }]));
  const project: Project = Object.assign({}, loaded, { dialogues });
  const host = { panel: 0, commands: [] as [string, Json[]][], outcome: false as boolean | string, holdCalls: 0, voices: [] as string[] };
  const verbs = new Map<string, QuestVerbDecl>([
    ['hold', { check: () => undefined, evaluate: () => { host.holdCalls++; return host.outcome; } }],
    ['deliver', {
      check: (_q, step) => { if (step.target !== 'mill') throw new Error('deliver target'); },
      evaluate: () => (options.badVerb === true ? 3 : false),
    }],
  ]);
  const storyHost: StoryHost = {
    facts: () => [{ key: 'met', default: false }, { key: 'gold', default: 0 }, { key: 'name', default: 'Ana' }, { key: 'rushed', default: false }],
    commands: () => new Set(['pay']),
    runCommand: (name, args) => { host.commands.push([name, [...args]]); },
    verbs: () => verbs,
    dialogueRef: (id) => `dialogue:${id}`,
    questRef: (id) => `quest:${id}`,
    localize: (key, text) => (key === 'story.elder.hello' ? text.replace('Welcome', 'Bienvenue') : text),
    openPanel: () => { host.panel++; },
    closePanel: () => { host.panel--; },
    voice: (sound) => { host.voices.push(sound); },
  };
  const plugin = story({ host: storyHost });
  const events: [string, Fields][] = [];
  const recorder: SystemDef = {
    id: 'recorder', scenes: [],
    handlers: Object.values(STORY_EVENTS).map((event) => ({ event, method: 'record' })),
    create: () => ({ record: (_ctx: unknown, e: Fields) => { events.push([eventName(e), e]); } }) as LogicInstance,
  };
  // The recorder can't see the event type in a payload: tag payloads by their keys.
  const eventName = (e: Fields): string => Object.keys(e).join(',');
  const game: GameDefinition = {
    components: [{ id: 'camera', schema: { follow: t.json({ default: null }) } }],
    resources: [], events: [DIED], behaviors: [], systems: [recorder],
  };
  const sections: SaveSection[] = [];
  const kernel = new Kernel({ project, game, plugins: [plugin], context: {}, fixedStep: DT });
  if (options.save === true) kernel.provide(SAVE_SERVICE, { register: (s) => { sections.push(s); } });
  let pressed = false;
  kernel.provide(DIALOGUE_INPUT_SERVICE, { confirmPressed: () => pressed });
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  (kernel.world.get(id('eye'))!.components.get('camera') as Fields)['follow'] = id('hero');
  return {
    kernel, engine: plugin.engine(), events, host, id, sections,
    steps: (n) => { for (let i = 0; i < n; i++) kernel.step(DT); },
    press: () => { pressed = true; kernel.step(DT); pressed = false; },
  };
}

describe('facts', () => {
  it('are typed, emit fact_changed only on change, and reset with a New Game', () => {
    const s = setup();
    s.engine.setFact('met', true);
    s.engine.setFact('met', true);
    expect(s.engine.addFact('gold', 2)).toBe(2);
    s.steps(1);
    expect(s.events.filter(([k]) => k === 'key').map(([, e]) => e['key'])).toEqual(['met', 'gold']);
    expect(code(() => s.engine.setFact('met', 1))).toBe('PP3981');
    expect(code(() => s.engine.setFact('nope', 1))).toBe('PP3980');
    expect(code(() => s.engine.addFact('name', 1))).toBe('PP3981');
    s.kernel.requestScene('main', { newRun: true });
    s.steps(1);
    expect(s.engine.fact('met')).toBe(false);
    expect(s.engine.fact('gold')).toBe(0);
  });
});

describe('dialogue', () => {
  it('runs lines, localizes them, waits for a press (not the starting frame), and takes choices', () => {
    const s = setup();
    s.engine.say('elder', 'start', s.id('elder'));
    expect(s.host.panel).toBe(1);
    expect(s.engine.inDialogue).toBe(true);
    expect(s.engine.view()).toMatchObject({ speaker: 'Elder', text: 'Bienvenue, Ana.', options: [] });
    s.press();
    expect(s.engine.view()!.options.map((o) => [o.text, o.enabled])).toEqual([['Ask for gold', true], ['Leave', false]]);
    expect(code(() => s.engine.next())).toBe('PP3986');
    expect(code(() => s.engine.choose(1))).toBe('PP3986');
    s.engine.choose(0);
    expect(s.engine.fact('gold')).toBe(2);
    expect(s.host.commands).toEqual([['pay', [5, 'coins']]]);
    expect(s.engine.view()).toMatchObject({ speaker: 'Elder', text: 'Off you go.' });
    // A #voice: tag plays its sound once, as the line is shown.
    expect(s.host.voices).toEqual(['elder_bye']);
    s.press();
    expect(s.host.voices).toEqual(['elder_bye']);
    expect(s.engine.inDialogue).toBe(false);
    expect(s.host.panel).toBe(0);
    s.steps(1);
    const names = s.events.map(([k]) => k);
    expect(names).toContain('dialogue,speaker');
    expect(s.events.find(([k]) => k === 'dialogue')![1]).toEqual({ dialogue: 'dialogue:elder' });
  });

  it("doesn't advance on the press that started the conversation", () => {
    const s = setup();
    s.kernel.addHook('input', () => { if (!s.engine.inDialogue) s.engine.say('elder', 'start', null); });
    s.press();
    expect(s.engine.view()!.text).toBe('Bienvenue, Ana.');
    s.press();
    expect(s.engine.view()!.options).toHaveLength(2);
  });

  it('jumps, waits on <<wait>>, and refuses a second conversation', () => {
    const s = setup();
    s.engine.setFact('met', true);
    s.engine.say('elder', 'start', null);
    s.steps(1);
    expect(s.engine.view()!.text).toBe('Again?');
    expect(code(() => s.engine.say('elder', 'start', null))).toBe('PP3991');
    s.press();
    s.engine.choose(1);
    expect(s.engine.view()).toMatchObject({ text: '', options: [] });
    s.steps(4);
    expect(s.engine.view()!.text).toBe('');
    s.steps(4);
    expect(s.engine.view()).toMatchObject({ node: 'bye', text: 'Bye.' });
    s.press();
    expect(s.engine.inDialogue).toBe(false);
  });

  it('reports unknown files and nodes, and broken .yarn at load with its line', () => {
    const s = setup();
    expect(code(() => s.engine.say('nobody', 'start', null))).toBe('PP2180');
    expect(code(() => s.engine.say('elder', 'middle', null))).toBe('PP3984');
    expect(code(() => setup({ dialogues: { elder: 'title: start\n---\nA: {$missing}\n===' } }))).toBe('PP2184');
    let error: unknown;
    try {
      setup({ dialogues: { elder: 'title: start\n---\n<<shout>>\n===' } });
    } catch (e) {
      error = e;
    }
    expect((error as ParallaxError).diagnostic).toMatchObject({ code: 'PP2187', path: 'story/elder.yarn', line: 3 });
  });
});

describe('quests', () => {
  it('walks a step graph: talk, defeat by prefab, custom verbs, branches, wait, markers and completion', () => {
    const s = setup();
    s.engine.startQuest('errand');
    expect(code(() => s.engine.startQuest('errand'))).toBe('PP3988');
    expect(s.engine.markers()).toEqual([]);
    // talk: a conversation with the placed elder ends.
    s.engine.say('elder', 'start', s.id('elder'));
    s.press();
    s.engine.choose(0);
    s.press();
    expect(s.engine.questState('errand').active).toEqual(['hunt']);
    expect(s.engine.fact('met')).toBe(true);
    // defeat counts deaths by prefab.
    const wolves = [...s.kernel.world.live()].filter((r) => r.prefab === 'wolf').map((r) => r.id);
    s.kernel.emit(DIED, { entity: wolves[0]! });
    s.steps(1);
    expect(s.engine.questState('errand').progress('hunt')).toEqual([1, 2]);
    s.kernel.emit(DIED, { entity: wolves[1]! });
    s.steps(1);
    // load is a custom verb asked every frame; the rushed fact sends it to escape.
    expect(s.engine.questState('errand').active).toEqual(['load']);
    s.engine.setFact('rushed', true);
    s.host.outcome = 'rushed';
    s.steps(1);
    expect(s.engine.questState('errand').active).toEqual(['escape']);
    s.steps(31);
    expect(s.engine.questState('errand').active).toEqual(['deliver']);
    expect(s.engine.markers()).toEqual([{ quest: 'errand', step: 'deliver', placed: 'mill' }]);
    const completed = s.events.filter(([k]) => k === 'quest,step,verb,outcome').map(([, e]) => [e['step'], e['outcome']]);
    expect(completed).toEqual([['meet', null], ['hunt', null], ['load', 'rushed'], ['escape', null]]);
    s.engine.failQuest('errand');
    expect(s.engine.questStatus('errand')).toBe('failed');
    expect(s.engine.quests('active')).toEqual([]);
    s.engine.startQuest('errand');
    expect(s.engine.questState('errand').active).toEqual(['meet']);
  });

  it('reach by region (the player is what the camera follows) and fact steps by value', () => {
    const s = setup();
    s.engine.startQuest('scout');
    s.steps(2);
    expect(s.engine.questState('scout').active).toEqual(['go']);
    s.kernel.world.get(s.id('hero'))!.transform.setWorldPosition(new Vec3(5, 0, 5));
    s.steps(1);
    expect(s.engine.questState('scout').active).toEqual(['gold']);
    s.engine.addFact('gold', 2);
    s.steps(1);
    expect(s.engine.questState('scout').progress('gold')).toEqual([2, 3]);
    s.engine.addFact('gold', 1);
    s.steps(1);
    expect(s.engine.questStatus('scout')).toBe('completed');
    expect(s.engine.quests('completed')).toEqual(['scout']);
    expect(code(() => s.engine.startQuest('scout'))).toBe('PP3988');
    expect(s.events.filter(([k]) => k === 'quest').map(([, e]) => e['quest'])).toEqual(['quest:scout', 'quest:scout']);
  });

  it('reach by a placed trigger, and report() for game-observed verbs', () => {
    const s = setup();
    s.engine.startQuest('scout');
    s.kernel.emit(KERNEL_EVENTS.triggerEntered, { entity: s.id('mill'), target: s.id('elder') });
    s.steps(1);
    expect(s.engine.questState('scout').active).toEqual(['go']);
    s.kernel.emit(KERNEL_EVENTS.triggerEntered, { entity: s.id('mill'), target: s.id('hero') });
    s.steps(1);
    expect(s.engine.questState('scout').active).toEqual(['gold']);
    expect(code(() => s.engine.report('fact', 'gold', 1))).toBe('PP3989');
    expect(code(() => s.engine.report('obtain', 'gold', 0))).toBe('PP3989');
  });

  it('a scene change ends a conversation without counting it as talking', () => {
    const s = setup();
    s.engine.startQuest('errand');
    s.engine.say('elder', 'start', s.id('elder'));
    s.kernel.requestScene('main');
    s.steps(1);
    expect(s.engine.inDialogue).toBe(false);
    expect(s.host.panel).toBe(0);
    expect(s.engine.questState('errand').active).toEqual(['meet']);
    expect(s.events.filter(([k]) => k === 'dialogue')).toHaveLength(1);
  });

  it('checks quest files against the game', () => {
    const quest = (steps: Record<string, unknown>): Record<string, unknown> => ({ q: { title: 'Q', summary: 'S', start: 'a', steps } });
    expect(code(() => setup({ quests: quest({ a: { text: 'x', verb: 'fly' } }) }))).toBe('PP2191');
    expect(code(() => setup({ quests: quest({ a: { text: 'x', verb: 'defeat', target: 'dragon' } }) }))).toBe('PP2191');
    expect(code(() => setup({ quests: quest({ a: { text: 'x', verb: 'reach', target: 'moon' } }) }))).toBe('PP2191');
    expect(code(() => setup({ quests: quest({ a: { text: 'x', verb: 'use', target: 'key', sets: ['gold'] } }) }))).toBe('PP2191');
    expect(code(() => setup({ quests: quest({ a: { text: 'x', verb: 'use', target: 'key', next: ['b'] } }) }))).toBe('PP2190');
    expect(code(() => setup({ quests: quest({ a: { text: 'x', verb: 'use', target: 'k', next_if: [{ goto: ['a'] }] } }) }))).toBe('PP2190');
    expect(code(() => setup({ quests: quest({ a: { text: 'x', verb: 'use', target: 'k', next_if: [{ fact: 'gold', goto: ['a'] }] } }) }))).toBe('PP2191');
    expect(code(() => setup({ quests: { q: { title: 'Q', summary: 'S', start: 'zz', steps: {} } } }))).toBe('PP2190');
  });

  it('rejects a custom verb result that is neither a bool nor an outcome', () => {
    const s = setup({ badVerb: true });
    s.engine.startQuest('errand');
    s.engine.say('elder', 'start', s.id('elder'));
    s.press();
    s.engine.choose(0);
    s.press();
    const wolves = [...s.kernel.world.live()].filter((r) => r.prefab === 'wolf').map((r) => r.id);
    for (const w of wolves) s.kernel.emit(DIED, { entity: w });
    s.host.outcome = true;
    expect(code(() => s.steps(3))).toBe('PP3990');
  });
});

describe('snapshots and saves', () => {
  it('restores facts, quests and a conversation mid-way', () => {
    const s = setup();
    s.engine.startQuest('errand');
    s.engine.say('elder', 'start', s.id('elder'));
    s.press();
    const snapshot = s.kernel.snapshot();
    s.engine.choose(0);
    s.press();
    expect(s.engine.inDialogue).toBe(false);
    s.kernel.restore(snapshot);
    expect(s.engine.inDialogue).toBe(true);
    expect(s.engine.fact('gold')).toBe(0);
    expect(s.engine.questState('errand').active).toEqual(['meet']);
    expect(s.engine.view()!.options.map((o) => o.text)).toEqual(['Ask for gold', 'Leave']);
    s.engine.choose(0);
    expect(s.engine.fact('gold')).toBe(2);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('gives slot saves "facts" and "quests" sections in SaveData shape', () => {
    const s = setup({ save: true });
    expect(s.sections.map((x) => x.key)).toEqual(['facts', 'quests']);
    s.engine.setFact('gold', 4);
    s.engine.startQuest('scout');
    const [facts, quests] = s.sections;
    expect(facts!.save()).toEqual({ met: false, gold: 4, name: 'Ana', rushed: false });
    expect((quests!.save() as Record<string, unknown>)['scout']).toEqual({ status: 'active', active_steps: ['go'], completed_steps: [], progress: {} });
    facts!.load({ gold: 9 });
    expect(s.engine.fact('gold')).toBe(9);
    quests!.load({ errand: { status: 'completed', active_steps: [], completed_steps: [], progress: {} } });
    expect(s.engine.questStatus('errand')).toBe('completed');
    expect(s.engine.questStatus('scout')).toBe('inactive');
    expect(code(() => facts!.load({ ghost: 1 }))).toBe('PP3982');
    expect(code(() => quests!.load({ errand: { status: 'active', active_steps: ['nope'] } }))).toBe('PP3982');
  });

  it('provides the story service', () => {
    const s = setup();
    const service = s.kernel.service(STORY_SERVICE);
    s.engine.startQuest('scout');
    expect(service.questStatus('scout')).toBe('active');
    expect(service.fact('name')).toBe('Ana');
    expect(service.players()).toEqual([s.id('hero')]);
  });
});
