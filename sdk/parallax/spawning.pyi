"""Spawning (plugins.spawning()): waves of spawns.

A `Spawner` runs its `waves` in order: each waits `delay`, then spawns one of its `prefabs`
every `interval` seconds — `count` of them, or until the wave's `budget` (the sum of the
choices' `cost`) can't pay for any choice — never more than `max_alive` alive at once. A
wave is cleared when everything it spawned is gone; the next starts `between_waves` later
(`loop` restarts from the first). Spawns go to `points` in turn (local offsets), else to a
random point in the `area` box (local half-extents); choices are drawn by `weight` from the
plugin's own seeded random, so replays and playtests spawn the same. Every counter is on
the component, so spawners save and replay.

    @system("arena")
    class Arena(System):
        @on(WaveCleared)
        def cleared(self, ctx, e: WaveCleared):
            ctx.ui.toast(f"Wave {e.wave + 1} cleared")
"""

from typing import Literal
from parallax import EngineComponent, Entity, PrefabRef, Vec3, component, event, field, record


@record
class SpawnChoice:
    prefab: PrefabRef
    weight: float = field(1, min=0)
    cost: float = field(1, min=0)


@record
class Wave:
    """`count` spawns, or until `budget` (sum of costs) can't pay for a choice."""
    count: int = field(0, min=0)
    budget: float = field(0, min=0)
    interval: float = field(0.5, min=0, unit="s")
    delay: float = field(0, min=0, unit="s")


@component("spawner")
class Spawner(EngineComponent):
    prefabs: list[SpawnChoice] = field()
    waves: list[Wave] = field()
    max_alive: int = field(10, min=1)
    area: Vec3 = field(Vec3(0, 0, 0), doc="Local half-extents of the box spawns land in.")
    points: list[Vec3] = field([], doc="Local spawn points, used in turn (instead of area).")
    auto_start: bool = field(True)
    loop: bool = field(False)
    between_waves: float = field(2, min=0, unit="s")
    phase: Literal["idle", "delay", "spawning", "clearing", "done"] = field("idle", doc="Kept by the engine.")
    wave: int = field(-1, min=-1, doc="Kept by the engine.")
    spawned: int = field(0, min=0, doc="Kept by the engine.")
    spent: float = field(0, min=0, doc="Kept by the engine.")
    next_at: float = field(0, doc="Kept by the engine.")
    alive: list[Entity] = field([], doc="Kept by the engine.")

    def start(self) -> None: ...
    def stop(self) -> None: ...
    @property
    def done(self) -> bool: ...
    @property
    def alive_count(self) -> int: ...


@event("wave_started", target="entity")
class WaveStarted:
    entity: Entity
    wave: int

@event("wave_cleared", target="entity")
class WaveCleared:
    entity: Entity
    wave: int

@event("spawner_done", target="entity")
class SpawnerDone:
    entity: Entity
