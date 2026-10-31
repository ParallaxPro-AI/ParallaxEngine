# Behaviors, systems, and events

Behaviors act on an entity. Systems coordinate the game. Both read and change
[declared data](data.md) through the context passed to their methods.

## Registration and hooks

A `@behavior("id")` class extends `Behavior` and attaches to a prefab through its
`behaviors` map. `self.entity` is the entity it belongs to. Declare settings with
`param()` and runtime state with `state()`; other instance fields are rejected.
`requires=[ComponentType]` declares components it needs on the entity.

A `@system("id")` class extends `System`. Register it in `Game(systems=[...])` or a
`Feature`'s `systems` list. Systems have no instance fields: keep state in resources.
Feature systems precede the game's systems in registration order;
`@system(after=[...])` dependencies can reorder them within that sequence.
Behaviors run in spawn order.

Hooks have these signatures:

| Hook | Purpose |
|---|---|
| `start(self, ctx)` | Initialize when the behavior or system comes into existence. |
| `update(self, ctx, dt)` | Per-frame logic. |
| `fixed_update(self, ctx, dt)` | Fixed-step logic. |
| `late_update(self, ctx, dt)` | Logic after the update phase. |
| `end(self, ctx)` | Behavior cleanup when its entity ends. |

`dt` is elapsed game time in seconds. Systems can declare `scenes=[Scenes.play]`
or scene tags to exist only in matching scenes. Panels and action sets can use the
same scene scopes.

## Events

Events carry typed messages between units. For example, `game/scoring.py` can define:

```python
from parallax import System, event, field, on, resource, system


@event("point_scored")
class PointScored:
    points: int


@resource("score")
class Score:
    total: int = field(0)


@system("scoring")
class Scoring(System):
    @on(PointScored)
    def scored(self, ctx, event: PointScored):
        ctx.get(Score).total += event.points
```

Register `Scoring` in the game's systems, then emit
`ctx.emit(PointScored(points=10))` from the logic that awards points.
Use events and shared data to communicate, rather than reaching into another
behavior or system.

Events emitted during a phase are delivered at its end, in emission order.
Emitting an event does not call its handlers immediately.

`@on(Event, where=lambda event: ...)` filters by event data. An event declared with
`@event("id", target="entity")` names an `Entity` field: only that entity's behaviors
receive it, along with subscribing systems. Untargeted events reach all subscribers.

## Conditions

`when=lambda ctx: ...` on a behavior or system gates its update hooks **and event
handlers**. The condition is checked before each, so a state change can stop later
work in the same frame. A handler that must run while the unit is gated uses
`@on(Event, always=True)`; `@on(..., when=...)` adds a condition to that handler.

Countdowns updated with `remaining -= dt` pause when their unit is gated. A deadline
compared with `ctx.time.now` continues to elapse while the gate is closed.
See [UI](ui.md#visibility-and-modals) for how modal panels affect simulation time.

## Tasks and timers

Use an async task for a sequence of game-time waits:

```python
async def award_bonus(ctx, task):
    await task.seconds(0.5)
    ctx.emit(PointScored(points=10))
```

Start it from a hook or handler with `ctx.run(award_bonus)`. Tasks can also wait
for frames, events, or conditions. A behavior's tasks end with its entity; a
system's tasks end on scene change. Running tasks and callback timers are not
saved. Use a declared deadline or a `Timer` record for timing that must survive a save.

`ctx.time.now` measures game time across scenes; `ctx.time.scene_time` resets on
scene load. Both stop while simulation is frozen. Use
`Timer.cooldown(seconds)` for a countdown that starts ready, or
`Timer.delay(seconds)` for one that must elapse first; call `.tick(dt)` from the
owning unit's update.

See [the core API](../reference/parallax.md) for hook, event, task, and timer
signatures; [world](world.md) for scene changes, [input](input.md) for actions,
and [UI](ui.md) for panels.
