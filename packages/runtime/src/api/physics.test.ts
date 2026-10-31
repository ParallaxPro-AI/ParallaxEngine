import { describe, expect, it } from 'vitest';
import { kw } from './kwargs.js';
import { Collider, Layers, layer, layerNames, physics2d, Rigidbody } from './physics.js';

describe('parallax.physics', () => {
  it('exposes component handles for the physics2d components', () => {
    expect(Rigidbody.__component_id__).toBe('rigidbody');
    expect(Collider.__component_id__).toBe('collider');
  });

  it('names layers after their attributes, in declaration order, inheriting parents', () => {
    class Base extends Layers { static player = layer(); static enemy = layer(); }
    class More extends Base { static pickup = layer(); }
    expect(layerNames(More)).toEqual(['player', 'enemy', 'pickup']);
    expect(More.pickup.name).toBe('pickup');
    expect(Layers.default.name).toBe('default');
    expect(() => layerNames(class NotLayers {})).toThrow(/PP3107/);
  });

  it('binds physics2d(*, gravity, layers) as Python does', () => {
    class Game extends Layers { static wall = layer(); }
    const plugin = physics2d(kw({ gravity: 0, layers: Game }));
    expect(plugin.id).toBe('physics2d');
    const collider = plugin.components!.find((c) => c.id === 'collider')!;
    expect(collider.schema['collides_with']!.default).toEqual(['default', 'wall']);
    expect(() => physics2d(kw({ gravty: 0 }))).toThrow(/PP3030/);
    expect(() => physics2d(0)).toThrow(/PP3030/);
  });
});
