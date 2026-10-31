import { describe, expect, it } from 'vitest';
import { fetchProjectFiles, needsRuntime, planOutsideChanges } from './outside_changes.js';
import { t } from './i18n.js';
import { currentSite, DEFAULT_SITE, setSite } from './site.js';

describe('files changed outside the editor', () => {
  it('takes data documents in place, leaves unsaved ones alone, reloads for markup and assets', () => {
    const changed = ['scenes/main/scene.json', 'prefabs/a.prefab.json', 'ui/hud.html', 'assets/images/a.png', 'game/main.py', 'tests/expected.json', 'story/intro.yarn'];
    expect(planOutsideChanges(changed, new Set(['prefabs/a.prefab.json']), false)).toEqual({
      documents: ['scenes/main/scene.json', 'story/intro.yarn'],
      conflicts: ['prefabs/a.prefab.json'],
      reload: ['ui/hud.html', 'assets/images/a.png', 'tests/expected.json'],
    });
    // Read-only: the host is writing the project, so its files win over unsaved edits.
    expect(planOutsideChanges(['prefabs/a.prefab.json'], new Set(['prefabs/a.prefab.json']), true))
      .toEqual({ documents: ['prefabs/a.prefab.json'], conflicts: [], reload: [] });
  });

  it('rebuilds the runtime for a new or changed asset document (a library model add), not for other data', () => {
    // An Asset Library add of a model piece: its model document and prefab.
    expect(needsRuntime(['assets/models/accordion.model.json', 'prefabs/accordion.prefab.json'])).toBe(true);
    expect(planOutsideChanges(['assets/models/accordion.model.json', 'prefabs/accordion.prefab.json'], new Set(), false).documents)
      .toEqual(['assets/models/accordion.model.json', 'prefabs/accordion.prefab.json']);
    expect(needsRuntime(['scenes/main/scene.json', 'prefabs/a.prefab.json', 'ui/hud.html'])).toBe(false);
    // Binary assets reload the page instead (planOutsideChanges' `reload`).
    expect(needsRuntime(['assets/images/a.png'])).toBe(false);
  });

  it('reads the new text from the server (a removed file is null)', async () => {
    const asked: string[] = [];
    const get = (async (url: string) => {
      asked.push(url);
      return url.includes('gone') ? new Response('', { status: 404 }) : new Response(`text of ${url}`);
    }) as typeof fetch;
    const files = await fetchProjectFiles(['scenes/my level/scene.json', 'prefabs/gone.prefab.json'], get);
    expect(asked).toEqual(['/project/scenes/my%20level/scene.json', '/project/prefabs/gone.prefab.json']);
    expect([...files]).toEqual([['scenes/my level/scene.json', 'text of /project/scenes/my%20level/scene.json'], ['prefabs/gone.prefab.json', null]]);
  });
});

describe('the site the editor names', () => {
  it('defaults to the built-in site, and a host replaces it', () => {
    expect(currentSite()).toEqual(DEFAULT_SITE);
    expect(t('publish.comingSoonText', { site: currentSite().host })).toContain('parallaxpro.ai');
    setSite({ name: 'Studio', host: 'games.example.com', logo: null });
    expect(currentSite()).toEqual({ name: 'Studio', host: 'games.example.com', logo: null });
    expect(t('publish.comingSoonText', { site: currentSite().host })).toContain('games.example.com');
    setSite(DEFAULT_SITE);
  });
});
