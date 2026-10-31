import { describe, expect, it, vi } from 'vitest';
import { syncProjectUrl, withProjectParam } from './project_switcher.js';
import type { ProjectUrlEnv } from './project_switcher.js';

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const LISTING = { current: 'tank_battle', projects: ['chess', 'racing', 'tank_battle'] };

function env(href: string, switchStatus = 200, remembered: string | null = null): ProjectUrlEnv & { replaced: string[]; reloads: number; posts: unknown[]; memo: string | null } {
  const state = {
    href, replaced: [] as string[], reloads: 0, posts: [] as unknown[], memo: remembered,
    replace(next: string) { state.replaced.push(next); },
    reload() { state.reloads++; },
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('projects.json')) return reply(200, LISTING);
      state.posts.push(JSON.parse(String(init?.body)));
      return switchStatus === 200 ? reply(200, { ok: true }) : reply(switchStatus, { error: 'Unsaved work' });
    }) as unknown as typeof fetch,
    memory: { get: () => state.memo, set: (value: string | null) => { state.memo = value; } },
  };
  return state;
}

describe('the project in the URL', () => {
  it('writes the served project into a URL that names none, keeping other parameters', async () => {
    const page = env('http://127.0.0.1:5180/?debug=1#x');
    expect(await syncProjectUrl(page)).toEqual({ reloading: false });
    expect(page.replaced).toEqual(['http://127.0.0.1:5180/?debug=1&project=tank_battle#x']);
    expect(page.posts).toEqual([]);
  });

  it('leaves a matching URL alone (no switch, no reload)', async () => {
    const page = env('http://127.0.0.1:5180/?project=tank_battle');
    expect(await syncProjectUrl(page)).toEqual({ reloading: false });
    expect(page.posts).toEqual([]);
    expect(page.reloads).toBe(0);
  });

  it('switches the server to a sibling the URL names, then reloads', async () => {
    const page = env('http://127.0.0.1:5180/?project=chess');
    expect(await syncProjectUrl(page)).toEqual({ reloading: true });
    expect(page.posts).toEqual([{ project: 'chess' }]);
    expect(page.reloads).toBe(1);
    expect(page.replaced).toEqual([]);
  });

  it('stays on the current project for an unknown name, with a problem to show', async () => {
    const page = env('http://127.0.0.1:5180/?project=nope');
    const result = await syncProjectUrl(page);
    expect(result.reloading).toBe(false);
    expect(result.problem).toMatch(/no project "nope"/);
    expect(page.replaced).toEqual(['http://127.0.0.1:5180/?project=tank_battle']);
    expect(page.posts).toEqual([]);
  });

  it('reports a refused switch, and never loops on a server that did not switch', async () => {
    const refused = env('http://127.0.0.1:5180/?project=chess', 409);
    expect((await syncProjectUrl(refused)).problem).toBe('Unsaved work');
    expect(refused.reloads).toBe(0);
    const stuck = env('http://127.0.0.1:5180/?project=chess', 200, 'chess');
    expect((await syncProjectUrl(stuck)).problem).toMatch(/would not switch/);
    expect(stuck.posts).toEqual([]);
    expect(stuck.memo).toBeNull();
  });

  it('does nothing off `parallax edit` (no project list)', async () => {
    const page = env('https://host.example/edit/');
    page.fetch = vi.fn(async () => reply(404, {})) as unknown as typeof fetch;
    expect(await syncProjectUrl(page)).toEqual({ reloading: false });
    expect(page.replaced).toEqual([]);
  });

  it('sets the parameter on any URL', () => {
    expect(withProjectParam('http://a/?project=x&y=1', 'chess')).toBe('http://a/?project=chess&y=1');
  });
});
