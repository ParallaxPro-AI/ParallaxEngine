/** The Python-facing side of physics depth: materials, joint/field/ragdoll handles, events, and the destruction factory. */

import { describe, expect, it } from 'vitest';
import { BreakableBroken, BreakableDamaged, Breakable, destruction } from './destruction.js';
import { kw } from './kwargs.js';
import { ForceField, Impact, Joint, JointBroken, material, materialSpecs, Materials, physics2d, Ragdoll } from './physics.js';
import { physics3d } from './physics3d.js';

describe('parallax.physics depth', () => {
  it('names materials after their attributes and hands their specs to the plugin', () => {
    class Base extends Materials { static ice = material(kw({ friction: 0.02 })); }
    class Game extends Base { static rubber = material(kw({ friction: 1, bounce: 0.8, sound: { toJSON: () => 'sfx/boing' }, impact_speed: 2 })); }
    expect(materialSpecs(Game)).toEqual({
      ice: { friction: 0.02, bounce: 0, sound: null, impact_speed: 1 },
      rubber: { friction: 1, bounce: 0.8, sound: 'sfx/boing', impact_speed: 2 },
    });
    expect(physics3d(kw({ materials: Game, interpolate: false })).id).toBe('physics3d');
    expect(physics2d(kw({ materials: Game })).components!.map((c) => c.id)).toEqual(['rigidbody', 'collider', 'joint', 'force_field']);
    expect(() => material(kw({ friction: 'lots' }))).toThrow(/PP3190/);
    expect(() => physics3d(kw({ materials: class NotMaterials {} }))).toThrow(/PP3107/);
    expect(() => physics3d(kw({ materials: class M extends Materials { static ice = material(kw({ friction: -1 })); } }))).toThrow(/PP3190/);
  });

  it('handles name the components and events', () => {
    expect([Joint, ForceField, Ragdoll, Breakable].map((h) => h.__component_id__)).toEqual(['joint', 'force_field', 'ragdoll', 'breakable']);
    expect([JointBroken, Impact, BreakableDamaged, BreakableBroken].map((e) => e.__event_id__)).toEqual(['joint_broken', 'impact', 'breakable_damaged', 'breakable_broken']);
    expect(destruction().id).toBe('destruction');
  });
});
