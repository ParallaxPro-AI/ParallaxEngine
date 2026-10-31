/**
 * `parallax.story` as compiled game code sees it, through `createRuntime` with story():
 * fact handles and `ctx.story.facts`, a game subclass of the built-in quest kind, a custom
 * verb with a typed target and an outcome, `step.resolve`, `@dialogue_command` with typed
 * arguments, `say` in the DialoguePanel advanced by any button, and the story events.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ParallaxError } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { UiDriver } from '../function/plugins/ui/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import type { Project } from '../resource/index.js';
import {
  Actions, button, content, createRuntime, field, Game, kw, on, resetDeclarations, rt, SceneRef, system, System, ui,
} from './index.js';
import type { Context, GameRuntime } from './index.js';
import { ContentRef } from './content.js';
import {
  DialogueEnded, DialoguePanel, DialogueRef, DialogueStarted, dialogue_command, fact, FactChanged,
  story as storyPlugin, QuestCompleted, QuestDef, QuestStarted, QuestStepCompleted, quest_verb, resetStory,
} from './story.js';
import type { StoryApi } from './story.js';

const PROJECT: Record<string, unknown> = {
  'prefabs/person.prefab.json': { components: {} },
  'scenes/town/scene.json': { entities: [{ id: 'keeper', prefab: 'person' }] },
  'content/place/mill.json': { label: 'Mill' },
  'assets/sfx/keeper_bye.ogg': '',
  'content/quest/delivery.json': {
    title: 'Delivery', summary: 'Bring it.', number: 1, start: 'talk',
    steps: {
      talk: { text: 'Talk to the keeper', verb: 'talk', target: 'keeper', next: ['drop'] },
      drop: {
        text: 'Drop it at {place}', verb: 'drop_off', target: 'mill', next: ['done'],
        next_if: [{ outcome: 'late', goto: ['apologize'] }],
      },
      apologize: { text: 'Apologize', verb: 'use', target: 'flowers' },
      done: { text: 'Collect', verb: 'obtain', target: 'pay', count: 2, sets: ['delivered'] },
    },
  },
};

const CHOICE = [
  'title: start',
  '---',
  'Guard: Halt.',
  '-> Pay',
  '    <<set $coins to 0>>',
  '-> Run',
  'Guard: Move along.',
  '===',
].join('\n');

const KEEPER = [
  'title: start',
  '---',
  'Keeper: Hello. You have {$coins} coins.',
  '<<tip 3 "thanks">>',
  'Keeper: Bye. #voice:keeper_bye',
  '===',
].join('\n');

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const log: string[] = [];
let lateness: boolean | string = false;

function start(): { runtime: GameRuntime; story: StoryApi; ctx: Context; audio: HeadlessAudio; press(): void; step(n?: number): void } {
  const Coins = fact('coins', 2);
  fact('delivered', false);

  class PlaceC { static __annotations__ = { label: () => rt.str }; }
  const PlaceDef = content('place')(PlaceC);

  class ChapterC extends (QuestDef as unknown as new () => object) {
    static __annotations__ = { number: () => rt.int };
    static number = field(kw({ min: 1 }));
  }
  const Chapter = content('quest', kw({ order: 'number' }))(ChapterC);

  quest_verb('drop_off', kw({ target: rt.generic(ContentRef, PlaceDef) }))(
    (ctx: Context, quest: ContentRef<{ number: number }>, step: { target: string; resolve(c: unknown): unknown }, dt: number) => {
      const place = step.resolve(ctx) as ContentRef<{ label: string }>;
      log.push(`verb ${quest.as_kind<{ number: number }>(Chapter).data.number} ${place.data.label} ${step.target} ${dt > 0}`);
      return lateness;
    },
  );

  const tip = (ctx: Context, amount: number, note: string): void => {
    (ctx as unknown as { story: StoryApi }).story.facts.add(Coins, amount);
    log.push(`tip ${amount} ${note}`);
  };
  (tip as unknown as { __annotations__: unknown }).__annotations__ = { ctx: () => Object, amount: () => rt.int, note: () => rt.str };
  dialogue_command('tip')(tip);

  class Controls extends Actions {
    static talk = button(kw({ keyboard: 'KeyE' }));
  }
  Controls.__init_subclass__();

  class Recorder extends System {
    started(_c: unknown, e: { dialogue: DialogueRef; speaker: unknown }) { log.push(`started ${e.dialogue.id} ${e.speaker !== null}`); }
    ended(_c: unknown, e: { dialogue: DialogueRef }) { log.push(`ended ${e.dialogue.id}`); }
    quest(_c: unknown, e: { quest: ContentRef<unknown> }) { log.push(`quest ${e.quest.id}`); }
    step_done(_c: unknown, e: { quest: ContentRef<unknown>; step: string; verb: string; outcome: string | null }) {
      log.push(`step ${e.quest.id}.${e.step} ${e.verb} ${e.outcome}`);
    }
    completed(_c: unknown, e: { quest: ContentRef<unknown> }) { log.push(`completed ${e.quest.id}`); }
    fact_changed(_c: unknown, e: { key: string }) { log.push(`fact ${e.key}`); }
  }
  on(DialogueStarted)(Recorder.prototype.started);
  on(DialogueEnded)(Recorder.prototype.ended);
  on(QuestStarted)(Recorder.prototype.quest);
  on(QuestStepCompleted)(Recorder.prototype.step_done);
  on(QuestCompleted)(Recorder.prototype.completed);
  on(FactChanged)(Recorder.prototype.fact_changed);
  system('recorder')(Recorder);

  const game = new Game(kw({
    id: 'town', title: 'Town', sdk: '1.0', mode: '3d', start_scene: new SceneRef('town'),
    plugins: [storyPlugin()], systems: [Recorder],
  }));
  const loaded = loadProject(files(PROJECT));
  expect(loaded.diagnostics).toEqual([]);
  const dialogues = new Map([
    ['keeper', { id: 'keeper', path: 'story/keeper.yarn', text: KEEPER }],
    ['guard', { id: 'guard', path: 'story/guard.yarn', text: CHOICE }],
  ]);
  const project: Project = Object.assign({}, loaded, { dialogues });
  const devices = new HeadlessInput();
  const audio = new HeadlessAudio();
  const runtime = createRuntime(game, project, {
    seed: 1, devices, audio, assets: null, files: files(PROJECT), surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
  });
  const talk = runtime.inputEngine.sets.find((s) => s.id === 'Controls')!.actions.get('talk')!;
  runtime.start();
  const ctx = runtime.ctx;
  const story = (ctx as unknown as { story: StoryApi }).story;
  return {
    runtime, story, ctx, audio,
    press: () => { runtime.inputEngine.inject(talk as never); runtime.step(1 / 60); },
    step: (n = 1) => { for (let i = 0; i < n; i++) runtime.step(1 / 60); },
  };
}

beforeEach(() => {
  resetDeclarations();
  resetStory();
  log.length = 0;
  lateness = false;
});

describe('parallax.story', () => {
  it('runs a conversation in the DialoguePanel, with facts, commands and talk progress', () => {
    const { runtime, story, ctx, press, step, audio } = start();
    const quest = ctx.content(QuestDef).get('delivery');
    story.start_quest(quest);
    const keeper = runtime.wrap([...runtime.kernel.world.live()].find((r) => r.placedId === 'keeper')!.id);
    story.say(new DialogueRef('keeper'), kw({ speaker: keeper }));
    expect(story.in_dialogue).toBe(true);
    expect(runtime.uiEngine.isOpen(DialoguePanel)).toBe(true);
    expect(story.__dialogue_view__()).toMatchObject({ speaker: 'Keeper', text: 'Hello. You have 2 coins.' });
    press();
    expect(story.facts.get(fact('coins', 2))).toBe(5);
    expect(story.__dialogue_view__()).toMatchObject({ text: 'Bye.' });
    step();
    // The voiced line plays its sound, ducking the music.
    expect(audio.plays.map((p) => [p.sound, p.duck])).toEqual([['sfx/keeper_bye', true]]);
    press();
    expect(story.in_dialogue).toBe(false);
    expect(runtime.uiEngine.isOpen(DialoguePanel)).toBe(false);
    step();
    expect(log).toEqual([
      'quest delivery', 'started keeper true', 'tip 3 thanks', 'fact coins', 'ended keeper', 'step delivery.talk talk null',
      'verb 1 Mill mill true',
    ]);
    expect(story.quest(quest).active_steps).toEqual(['drop']);
  });

  it('a game\'s DialoguePanel subclass (its restyled look) is the one conversations open', () => {
    class MyDialogue extends DialoguePanel {}
    ui('my_dialogue', kw({ html: 'ui/dialogue.html', modal: true, layer: 'overlay' }))(MyDialogue);
    const { runtime, story, step } = start();
    story.say(new DialogueRef('guard'));
    step();
    expect(runtime.uiEngine.isOpen(MyDialogue)).toBe(true);
    expect(runtime.uiEngine.isOpen(DialoguePanel)).toBe(false);
    expect(new UiDriver(runtime.uiEngine).stateOf(MyDialogue)).toMatchObject({ speaker: 'Guard', text: 'Halt.' });
  });

  it('drives the modal DialoguePanel through its state and its next / choose actions', () => {
    const { runtime, story, ctx, step } = start();
    const panel = new UiDriver(runtime.uiEngine);
    story.say(new DialogueRef('guard'));
    step();
    expect(runtime.uiEngine.modalOpen()).toBe(true);
    expect(panel.stateOf(DialoguePanel)).toMatchObject({ speaker: 'Guard', text: 'Halt.', options: [] });
    panel.click(DialoguePanel, 'next');
    step();
    const options = (panel.stateOf(DialoguePanel)['options'] as { index: number; text: string }[]).map((o) => [o.index, o.text]);
    expect(options).toEqual([[0, 'Pay'], [1, 'Run']]);
    panel.click(DialoguePanel, 'choose', { option: 0 });
    step();
    expect((ctx as unknown as { story: StoryApi }).story.facts.get(fact('coins', 2))).toBe(0);
    expect(story.__dialogue_view__()).toMatchObject({ text: 'Move along.' });
    panel.click(DialoguePanel, 'next');
    step();
    expect(story.in_dialogue).toBe(false);
    expect(runtime.uiEngine.isOpen(DialoguePanel)).toBe(false);
  });

  it('branches on a custom verb outcome, counts reported progress, and sets facts', () => {
    const { story, ctx, step } = start();
    const quest = ctx.content(QuestDef).get('delivery');
    story.start_quest(quest);
    story.report('talk', 'keeper');
    step();
    lateness = 'late';
    step();
    expect(story.quest(quest).active_steps).toEqual(['apologize']);
    story.report('use', 'flowers');
    expect(story.quest(quest).status).toBe('completed');
    expect(story.quests('completed').map((q) => (q as ContentRef<unknown>).id)).toEqual(['delivery']);
  });

  it('counts toward a step and reports its progress, then sets its facts', () => {
    const { story, ctx, step } = start();
    const quest = ctx.content(QuestDef).get('delivery');
    story.start_quest(quest);
    story.report('talk', 'keeper');
    lateness = true;
    step();
    story.report('obtain', 'pay');
    expect(story.quest(quest).progress('done')).toEqual([1, 2]);
    story.report('obtain', 'pay');
    step();
    expect(story.facts.get(fact('delivered', false))).toBe(true);
    expect(log.filter((l) => l.startsWith('completed'))).toEqual(['completed delivery']);
  });

  it('reports misuse with coded errors', () => {
    const { story } = start();
    const code = (fn: () => unknown): string | undefined => {
      try { fn(); } catch (e) { return e instanceof ParallaxError ? e.diagnostic.code : String(e); }
      return undefined;
    };
    expect(code(() => story.say('keeper'))).toBe('PP3992');
    expect(code(() => story.start_quest('delivery'))).toBe('PP3992');
    expect(code(() => story.facts.get('coins'))).toBe('PP3992');
    expect(code(() => fact('coins', 'many'))).toBe('PP4181');
    expect(code(() => fact('Bad.Key', 1))).toBe('PP4180');
    expect(code(() => quest_verb('talk'))).toBe('PP4182');
    expect(code(() => dialogue_command('set'))).toBe('PP4183');
  });
});
