/**
 * Vehicle and combat data checks over a real example (read-only): open_world_sandbox's car
 * with depth components added in memory, then broken one at a time; strike content.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '@parallax/runtime/core';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const DIR = fileURLToPath(new URL('../../../examples/open_world_sandbox', import.meta.url));
const CAR = 'features/driving/prefabs/car.prefab.json';

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

function withCar(extra: Record<string, unknown>, more: Record<string, string> = {}, vehicle?: Record<string, unknown>): string[] {
  const car = JSON.parse(files[CAR]!) as { components: Record<string, unknown> };
  Object.assign(car.components, extra);
  if (vehicle !== undefined) car.components['vehicle'] = { ...(car.components['vehicle'] as object), ...vehicle };
  const found: readonly Diagnostic[] = checkFiles(memoryFiles({ ...files, [CAR]: JSON.stringify(car), ...more }), declarations, { assetFiles: false }).diagnostics;
  return found.filter((d) => /^PP27[05]/.test(d.code) || d.severity === 'error').map((d) => `${d.code} ${d.pointer ?? ''}`);
}

describe('vehicle checks', () => {
  it('accepts well-formed depth components', () => {
    expect(withCar({
      drivetrain: { gearbox: 'auto', gears: [3, 2, 1.4, 1] },
      vehicle_damage: { parts: [{ name: 'engine', role: 'engine' }, { name: 'fl', role: 'wheel', index: 0 }] },
    })).toEqual([]);
  });

  it('a boat needs buoyancy (PP2706)', () => {
    // On the car and on each prefab that extends it.
    expect([...new Set(withCar({}, {}, { kind: 'boat' }))]).toEqual(['PP2706 /components/vehicle/kind']);
    expect(withCar({ buoyancy: {} }, {}, { kind: 'boat' }).filter((d) => d.startsWith('PP2706'))).toEqual([]);
  });

  it('reports misplaced components, unknown children, bad parts', () => {
    expect(withCar({ drivetrain: {}, vehicle_effects: { exhaust: 'pipe' } }, {}, { kind: 'plane' })).toEqual([
      'PP2701 /components/drivetrain', 'PP2702 /components/vehicle_effects/exhaust',
    ]);
    expect(withCar({ vehicle_damage: { parts: [{ name: 'a', role: 'wheel' }, { name: 'a' }] } })).toEqual([
      'PP2704 /components/vehicle_damage/parts/0/index', 'PP2704 /components/vehicle_damage/parts/1/name',
    ]);
  });

  it('strike content needs both markers or neither', () => {
    const strike = { 'content/strike/jab.json': JSON.stringify({ damage: 5, start_event: 'on' }), 'content/strike/bad.json': JSON.stringify({ active: [0.3, 0.1] }) };
    expect(withCar({}, strike)).toEqual(['PP2750 /active', 'PP2750 /start_event']);
  });
});
