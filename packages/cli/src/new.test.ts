/**
 * `parallax new`: argument parsing, the copy (title/id substitution, the `gitignore`
 * rename), what it refuses, and — for every template — that the fresh project checks
 * clean (with and without asset files) and its playtests pass.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './cli.js';
import { DEFAULT_TEMPLATE, TEMPLATES, TEMPLATES_DIR, gameId, listExamples, newArgs, titleFrom } from './new.js';

const scratch = mkdtempSync(`${tmpdir()}/parallax-new-`);
let out: string;
let err: string;

beforeEach(() => {
  out = '';
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('parallax new', () => {
  it('parses its arguments', () => {
    expect(newArgs(['g'])).toEqual({ dir: 'g', template: DEFAULT_TEMPLATE });
    expect(newArgs(['g', '--template', 'blank-3d', '--name', 'Space Run'])).toEqual({ dir: 'g', template: 'blank-3d', title: 'Space Run' });
    expect(newArgs(['--list'])).toBe('list');
    expect(newArgs([])).toMatch(/needs the folder/);
    expect(newArgs(['g', '--template'])).toMatch(/needs a value/);
    expect(newArgs(['g', '--fast'])).toMatch(/Unknown option/);
    expect(newArgs(['g', 'h'])).toMatch(/Unexpected argument/);
    expect(newArgs(['g', '--example', 'racing'])).toEqual({ dir: 'g', template: DEFAULT_TEMPLATE, example: 'racing' });
    expect(newArgs(['g', '--example', 'racing', '--template', 'blank-3d'])).toMatch(/exclusive/);
    expect(newArgs(['g', '--example'])).toMatch(/needs a value/);
  });

  it('derives the game id and title from the folder name', () => {
    expect(gameId('My Game-2')).toBe('my_game_2');
    expect(gameId('3d-run')).toBe('game_3d_run');
    expect(gameId('---')).toBe('game');
    expect(titleFrom('space_run')).toBe('Space Run');
    expect(titleFrom('---')).toBe('My Game');
  });

  it('lists every template folder, and only those', async () => {
    const folders = readdirSync(TEMPLATES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(folders.sort()).toEqual(Object.keys(TEMPLATES).sort());
    expect(await main(['new', '--list'])).toBe(0);
    for (const name of folders) expect(out).toContain(name);
  });

  it('creates the project with the title and id filled in', async () => {
    const dir = `${scratch}/space_run`;
    expect(await main(['new', dir, '--name', 'Space Run!'])).toBe(0);
    expect(readFileSync(`${dir}/game/main.py`, 'utf8')).toContain('id="space_run",\n    title="Space Run!",');
    expect(JSON.parse(readFileSync(`${dir}/locale/en.json`, 'utf8'))).toMatchObject({ game_title: 'Space Run!' });
    expect(readFileSync(`${dir}/.gitignore`, 'utf8')).toContain('build/');
    expect(existsSync(`${dir}/gitignore`)).toBe(false);
    expect(out).toContain('parallax check');
    expect(out).toContain('parallax test');
    expect(out).toContain('parallax edit');
  });

  it('creates into an existing empty folder', async () => {
    const dir = `${scratch}/empty`;
    mkdirSync(dir, { recursive: true });
    expect(await main(['new', dir])).toBe(0);
    expect(readFileSync(`${dir}/game/main.py`, 'utf8')).toContain('title="Empty"');
  });

  it('refuses a folder that is not empty, and leaves it alone (exit 1)', async () => {
    const dir = `${scratch}/taken`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/notes.txt`, 'mine');
    expect(await main(['new', dir])).toBe(1);
    expect(err).toMatch(/is not empty/);
    expect(readdirSync(dir, { withFileTypes: true }).map((e) => e.name)).toEqual(['notes.txt']);
    expect(await main(['new', `${dir}/notes.txt`])).toBe(1);
    expect(err).toMatch(/is a file/);
  });

  it('rejects an unknown template by listing the real ones, and bad usage (exit 2)', async () => {
    expect(await main(['new', `${scratch}/never`, '--template', 'mmo'])).toBe(2);
    expect(err).toContain('Unknown template "mmo"');
    for (const name of Object.keys(TEMPLATES)) expect(err).toContain(name);
    expect(await main(['new'])).toBe(2);
    expect(await main(['new', `${scratch}/never`, '--name', 'Say "hi"'])).toBe(2);
    expect(existsSync(`${scratch}/never`)).toBe(false);
  });

  it('lists the examples and copies one with only its id and title changed, minus generated output', async () => {
    const examples = listExamples();
    expect(examples.map((e) => e.name)).toContain('racing');
    expect(await main(['new', '--list'])).toBe(0);
    expect(out).toContain('Street Racer');
    const dir = `${scratch}/snow_run`;
    expect(await main(['new', dir, '--example', 'racing', '--name', 'Snow Run'])).toBe(0);
    const source = readFileSync(`${dir}/game/main.py`, 'utf8');
    expect(source).toContain('id="snow_run",\n    title="Snow Run",');
    expect(source.replace('id="snow_run"', '').replace('title="Snow Run"', ''))
      .toBe(readFileSync('../../examples/racing/game/main.py', 'utf8').replace('id="racing"', '').replace('title="Street Racer"', ''));
    expect(existsSync(`${dir}/.parallax/library.json`)).toBe(true);
    expect(existsSync(`${dir}/build`)).toBe(false);
    out = '';
    expect(await main(['check', dir, '--no-write']), out).toBe(0);
    expect(out).toContain('0 errors');
  });

  it('rejects an unknown example by listing the real ones (exit 2)', async () => {
    expect(await main(['new', `${scratch}/never`, '--example', 'mmo'])).toBe(2);
    expect(err).toContain('Unknown example "mmo"');
    expect(err).toContain('racing');
    expect(existsSync(`${scratch}/never`)).toBe(false);
  });

  for (const template of Object.keys(TEMPLATES)) {
    it(`${template}: the new project checks clean and its playtests pass`, async () => {
      const dir = `${scratch}/fresh_${template.replaceAll('-', '_')}`;
      expect(await main(['new', dir, '--template', template])).toBe(0);
      for (const flags of [['--no-asset-files'], []]) {
        out = '';
        expect(await main(['check', dir, '--no-write', ...flags]), out).toBe(0);
        expect(out).toContain('0 errors, 0 warnings');
      }
      out = '';
      expect(await main(['test', dir]), `${out}${err}`).toBe(0);
      expect(out).toMatch(/\d+ passed, 0 failed, 0 errors/);
    });
  }
});
