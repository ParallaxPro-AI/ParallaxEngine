/**
 * The AI builder's gate: `parallax check --json` and `parallax test --json [--observe]`
 * hold to the JSON schemas in `contracts/` (this package), on a real project run
 * through the real transpiler, checker and harness.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkProject, resultJson } from '@parallax/check';
import { validate } from './schema_check.js';
import { reportJson } from './report.js';
import { runProjectTests } from './runner.js';

const fixture = fileURLToPath(new URL('./fixtures/observed', import.meta.url));
const contracts = new URL('../contracts/', import.meta.url);
const schema = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(name, contracts), 'utf8')) as Record<string, unknown>;

describe('parallax test --json --observe', async () => {
  const report = await runProjectTests(fixture, { observe: true });
  const json = JSON.parse(reportJson(report)) as { results: { name: string; status: string; observation?: unknown }[] };

  it('matches test_report.schema.json', () => {
    expect(validate(schema('test_report.schema.json'), json)).toEqual([]);
    expect(json.results.map((r) => `${r.name}:${r.status}`)).toEqual(['test_drawn:passed', 'test_fails:failed', 'test_plain:passed']);
  });

  it('attaches each playtest\'s final observation (observation.schema.json), passed or failed; plain tests get none', () => {
    const observation = schema('observation.schema.json');
    for (const r of json.results.filter((x) => x.name !== 'test_plain')) {
      expect(validate(observation, r.observation)).toEqual([]);
    }
    const drawn = json.results[0]!.observation as { entities: { placedId: string | null; onScreen: boolean; screen: { x: number } | null }[] };
    const block = drawn.entities.find((e) => e.placedId === 'block')!;
    expect(block.onScreen).toBe(true);
    expect(json.results[2]!.observation).toBeUndefined();
  });
});

describe('parallax check --json', () => {
  it('matches check_result.schema.json', () => {
    const result = JSON.parse(resultJson(checkProject(fixture, { outDir: false, assetFiles: false }))) as unknown;
    expect(validate(schema('check_result.schema.json'), result)).toEqual([]);
  });

  it('a project with errors still matches, with coded diagnostics', () => {
    const broken = fileURLToPath(new URL('./fixtures/observed_broken', import.meta.url));
    const result = JSON.parse(resultJson(checkProject(broken, { outDir: false, assetFiles: false }))) as { errors: number; diagnostics: { code: string }[] };
    expect(validate(schema('check_result.schema.json'), result)).toEqual([]);
    expect(result.errors).toBeGreaterThan(0);
    expect(result.diagnostics.every((d) => /^PP\d{4}$/.test(d.code))).toBe(true);
  });
});
