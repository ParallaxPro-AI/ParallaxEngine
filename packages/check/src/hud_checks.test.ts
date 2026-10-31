/**
 * HUD data checks over a real example (read-only): the FPS example with the hud plugin
 * set (or removed) in memory, then stat bar paths and action names broken one at a time.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '@parallax/runtime/core';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const DIR = fileURLToPath(new URL('../../../examples/fps_shooter', import.meta.url));
const PLAYER = 'prefabs/player.prefab.json';

let files: Record<string, string>;
let declarations: Declarations;

beforeAll(() => {
  const tree = directoryFiles(DIR);
  files = {};
  for (const path of tree.all()) if (!/\.(png|glb|ogg|mp3|wav)$/.test(path)) files[path] = tree.read(path);
  const extracted = runExtract(DIR);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  declarations = extracted.declarations;
});

function withHud(hud: Record<string, unknown>, plugin = true): readonly Diagnostic[] {
  const player = JSON.parse(files[PLAYER]!) as { components: Record<string, unknown> };
  Object.assign(player.components, hud);
  const decl = structuredClone(declarations) as Declarations & { game: { plugins: { id: string }[] } };
  // The example declares hud() itself now; drop it so `plugin` alone decides.
  decl.game.plugins = decl.game.plugins.filter((p) => p.id !== 'hud');
  if (plugin) decl.game.plugins.push({ id: 'hud', options: {}, line: 1 } as never);
  return checkFiles(memoryFiles({ ...files, [PLAYER]: JSON.stringify(player) }), decl, { assetFiles: false }).diagnostics;
}

function brief(found: readonly Diagnostic[]): string[] {
  return found.filter((d) => d.code.startsWith('PP255') || d.code === 'PP2050' || d.code === 'PP2051').map((d) => `${d.code} ${d.pointer ?? ''}`);
}

describe('hud checks', () => {
  it('accepts good paths and action names', () => {
    expect(brief(withHud({
      stat_bars: { bars: [{ label: 'HP', value: 'health.current', max: 'health.max' }] },
      key_hints: { actions: ['FpsControls.jump', 'FpsControls.reload'] },
      abilities: { slots: [{ id: 'nade', cooldown: 4, action: 'FpsControls.jump' }] },
      minimap: {}, crosshair: { spread: 2 },
    }))).toEqual([]);
  });

  it('a stat bar path must name a number field of a component; one off the entity is a warning', () => {
    expect(brief(withHud({ stat_bars: { bars: [{ value: 'helth.current' }, { value: 'health.curent' }, { value: 'side.side' }, { value: 'xp.points' }] } })))
      .toEqual([
        'PP2550 /components/stat_bars/bars/0/value',
        'PP2550 /components/stat_bars/bars/1/value',
        'PP2550 /components/stat_bars/bars/2/value',
        'PP2550 /components/stat_bars/bars/3/value',
      ]);
    const found = withHud({ stat_bars: { bars: [{ value: 'awareness.level' }] } });
    expect(brief(found)).toEqual(['PP2552 /components/stat_bars/bars/0/value']);
    expect(found.find((d) => d.code === 'PP2552')!.severity).toBe('warning');
  });

  it('key hints and ability slots name declared actions', () => {
    const found = withHud({ key_hints: { actions: ['FpsControls.jmp'] }, abilities: { slots: [{ id: 'a', cooldown: 1, action: 'Controls.fire' }] } });
    expect(brief(found)).toEqual(['PP2551 /components/abilities/slots/0/action', 'PP2551 /components/key_hints/actions/0']);
    expect(found.find((d) => d.pointer === '/components/key_hints/actions/0')!.fix).toContain('FpsControls.jump');
  });

  it('HUD components need the hud plugin', () => {
    expect(withHud({ minimap: {} }, false).some((d) => d.severity === 'error' && d.message.includes('minimap'))).toBe(true);
  });

  it('an ability slot image is an image file in assets/', () => {
    const player = JSON.parse(files[PLAYER]!) as { components: Record<string, unknown> };
    const slots = (image: string): unknown => ({ slots: [{ id: 'nade', cooldown: 4, image }] });
    const run = (image: string): string[] => {
      Object.assign(player.components, { abilities: slots(image) });
      const decl = structuredClone(declarations) as Declarations & { game: { plugins: { id: string }[] } };
      decl.game.plugins.push({ id: 'hud', options: {}, line: 1 } as never);
      const tree = memoryFiles({ ...files, 'assets/ui/nade.png': '', [PLAYER]: JSON.stringify(player) });
      return checkFiles(tree, decl, {}).diagnostics.filter((d) => d.code === 'PP2554').map((d) => `${d.pointer} ${d.fix ?? ''}`);
    };
    expect(run('assets/ui/nade.png')).toEqual([]);
    expect(run('assets/ui/nades.png')).toEqual(['/components/abilities/slots/0/image Did you mean "assets/ui/nade.png"?']);
  });

  it('Marker (core) and HealthBar (combat) without hud(): a warning that nothing draws them', () => {
    const found = withHud({ marker: { icon: 'star' }, health_bar: {} }, false).filter((d) => d.code === 'PP2553' && d.path === PLAYER);
    expect(found.map((d) => [d.severity, d.path, d.pointer])).toEqual([
      ['warning', PLAYER, '/components/health_bar'], ['warning', PLAYER, '/components/marker'],
    ]);
    expect(withHud({ marker: { icon: 'star' }, health_bar: {} }).filter((d) => d.code === 'PP2553')).toEqual([]);
  });
});
