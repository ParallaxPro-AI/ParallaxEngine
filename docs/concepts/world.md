# Scenes and entities

A prefab describes an entity. A scene places instances of prefabs in the world.
Python code reads and changes the live entities created from those files.

## Prefabs and placements

For example, `prefabs/token.prefab.json` defines a reusable 2D shape:

```json
{
  "components": {
    "shape": { "kind": "circle", "size": [0.6, 0.6], "color": "#ffd166" }
  }
}
```

A scene places it by prefab id. In `scenes/arena/scene.json`:

```json
{
  "entities": [
    { "id": "prize", "prefab": "token", "at": [2, 1] }
  ]
}
```

The placement can override component fields, tags and behavior parameters without
changing the prefab. Its optional `id` gives code a stable reference:

```python
from project import Placed, Prefabs

def duplicate_prize(ctx):
    prize = ctx.world.placed(Placed.prize)
    return ctx.world.spawn(Prefabs.token, at=prize.transform.position)
```

Use `children` in a prefab for a hierarchy. A child can use another prefab or define
its own components; name it when code needs `entity.child("name")`. Child transforms
are relative to their parent.

## Transforms

Every entity has `entity.transform`; it is not a component to add. Positions use
meters, time uses seconds, and Euler angles use degrees.

- **2D:** x/y is the play plane; z controls draw order. A numeric rotation is an angle.
- **3D:** +x is right, +y is up, +z is forward. A numeric rotation is yaw; an array is
  `[pitch, yaw, roll]`. Positive yaw turns forward toward +x.

Use `position` for world coordinates and `local_position` for parent-relative ones.
For a physics-driven body, use its physics API to move it; see
[physics](../reference/parallax.physics.md).

## Scenes

`Game(start_scene=Scenes.arena, ...)` chooses the first scene. A scene can also declare
panels, music, environment settings and initial resource values. Call
`ctx.scenes.load(Scenes.other)` or `ctx.scenes.reload()` to replace it. Entities are
recreated on a load; [resources](data.md) hold state that must outlive them.

Scope systems, panels and action sets with `scenes=`. It accepts scene references
or scene tags, so several levels can share the same gameplay code.

Prefabs and scenes can `"extends"` another of their kind. Objects merge by field;
ordinary lists replace the inherited list; `null` removes an inherited value.
Scene entities merge by `id`, prefab children by `name`; unmatched entries are added.
A derived scene's `exclude` list removes inherited placements by id.

## Plugins

Rendering, input, UI, audio and the camera are available without extra plugins.
Add capabilities such as physics, characters or terrain to `Game(plugins=[...])`.
Importing a plugin's API does not install it. Check its dependencies in the
[plugin reference](../reference/parallax.plugins.md).

For outdoor ground, vegetation, sky, weather, water and generated buildings, see
[making a game look good](visuals.md). For streamed worlds and procedural scenes,
start with the [terrain](../reference/parallax.terrain.md), [city](../reference/parallax.city.md)
and [procedural generation](../reference/parallax.procgen.md) references.
See [assets](assets.md) for models and effects, and the
[core API](../reference/parallax.md) for entity, transform and scene methods.
