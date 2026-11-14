import { describe, expect, it } from 'vitest';
import type { AudioSpeak, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { GameDefinition, ResourceDef } from '../../kernel/index.js';
import { HeadlessAudio } from '../../../platform/headless/audio.js';
import { pickVoice, SpeechOutput } from '../../../platform/browser/speech.js';
import type { SpeechLike, UtteranceLike, VoiceLike } from '../../../platform/browser/speech.js';
import { audio } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const SETTINGS_DEF: ResourceDef = {
  id: 'settings',
  keep: 'profile',
  schema: { master_volume: t.number({ default: 1 }), music_volume: t.number({ default: 1 }), sfx_volume: t.number({ default: 1 }) },
};

function setup() {
  const project = loadProject(files({
    'assets/audio.json': { 'sfx/line': { group: 'voice' } },
    'prefabs/camera.prefab.json': { components: { camera: {} } },
    'scenes/main/scene.json': { entities: [{ prefab: 'camera', id: 'cam', at: [0, 0, 0] }] },
  }));
  const out = new HeadlessAudio();
  const plugin = audio({ output: out, assets: ['assets/sfx/line.ogg'], defaults: project.audio, seed: 1, mode: '3d' });
  const game: GameDefinition = {
    components: [{ id: 'camera', schema: {} }, { id: 'audio_source', schema: {} }], resources: [SETTINGS_DEF], events: [], behaviors: [], systems: [],
  };
  const kernel = new Kernel({ project, game, plugins: [plugin], context: {}, fixedStep: DT });
  kernel.start('main');
  return { kernel, out, engine: plugin.engine, step: () => kernel.step(DT) };
}

describe('ctx.audio.speak (text-to-speech)', () => {
  it('sends the line with its voice settings in the frame, and the output records it', () => {
    const g = setup();
    g.engine.speak({ text: '  Hello there.  ', voice: 'en-GB|male', pitch: 0.7, rate: 0.9 });
    g.engine.speak({ text: 'Next line.', interrupt: false });
    g.step();
    expect(g.out.speeches.map((s) => [s.text, s.voice, s.pitch, s.rate, s.volume, s.interrupt])).toEqual([
      ['Hello there.', 'en-GB|male', 0.7, 0.9, 1, true],
      ['Next line.', null, 1, 1, 1, false],
    ]);
  });

  it('skips empty lines, scales by a mix group, and stops on request', () => {
    const g = setup();
    g.engine.setGroup('voice', 0.5);
    g.engine.speak({ text: '   ' });
    g.engine.speak({ text: 'Half as loud.', group: 'voice' });
    g.engine.stopSpeaking();
    g.step();
    expect(g.out.speeches.map((s) => [s.text, s.volume])).toEqual([['Half as loud.', 0.5]]);
    expect(g.out.speechStops).toBe(1);
  });

  it('rejects pitch and rate out of range (PP3501), and a group audio.json does not have (PP3518)', () => {
    const g = setup();
    expect(() => g.engine.speak({ text: 'x', group: 'voise' })).toThrow(/PP3518.*"voise"[\s\S]*Did you mean "voice"/);
    expect(() => g.engine.speak({ text: 'x', pitch: 3 })).toThrow(/PP3501/);
    expect(() => g.engine.speak({ text: 'x', rate: 0 })).toThrow(/PP3501/);
  });
});

describe('browser speech output', () => {
  const voices: VoiceLike[] = [
    { name: 'Google US English', lang: 'en-US' }, { name: 'Daniel', lang: 'en-GB' }, { name: 'Samantha (female)', lang: 'en-US' },
  ];

  it('picks a voice by name or language, trying "|" fallbacks in order', () => {
    expect(pickVoice(voices, 'daniel')?.name).toBe('Daniel');
    expect(pickVoice(voices, 'en-GB')?.name).toBe('Daniel');
    expect(pickVoice(voices, 'klingon|female')?.name).toBe('Samantha (female)');
    expect(pickVoice(voices, 'klingon')).toBeNull();
    expect(pickVoice(voices, null)).toBeNull();
  });

  it('speaks through speechSynthesis at the bus level, cancelling first when interrupting', () => {
    const log: string[] = [];
    const spoken: UtteranceLike[] = [];
    const fake: SpeechLike = {
      speak: (u) => { log.push(`speak:${u.text}`); spoken.push(u); },
      cancel: () => { log.push('cancel'); },
      getVoices: () => voices,
      utterance: (text) => ({ text, pitch: 1, rate: 1, volume: 1, voice: null, lang: '' }),
    };
    const out = new SpeechOutput(fake);
    const line = (text: string, interrupt: boolean): AudioSpeak => ({ kind: 'speak', text, voice: 'en-GB', pitch: 0.6, rate: 1.2, volume: 0.8, interrupt });
    out.speak(line('one', true), 0.5);
    out.speak(line('two', false), 0.5);
    out.speak(line('muted', false), 0);
    out.stop();
    expect(log).toEqual(['cancel', 'speak:one', 'speak:two', 'cancel']);
    expect(spoken[0]).toMatchObject({ pitch: 0.6, rate: 1.2, volume: 0.4, lang: 'en-GB' });
    expect(spoken[0]!.voice?.name).toBe('Daniel');
  });

  it('is silent where the page has no speech synthesis', () => {
    const out = new SpeechOutput(null);
    expect(() => out.speak({ kind: 'speak', text: 'x', voice: null, pitch: 1, rate: 1, volume: 1, interrupt: true }, 1)).not.toThrow();
  });
});
