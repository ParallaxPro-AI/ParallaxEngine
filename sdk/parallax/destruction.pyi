"""Destruction plugin (physics3d): breakable objects and impact damage.

A Breakable loses `health` from impacts (contacts of at least `impact_threshold` newtons
deal force / impact_threshold damage), from `damage()` and from `ctx.destruction.blast`.
At 0 it breaks: `BreakableBroken`, its `pieces` prefab spawns at its pose, and it is gone
the next step."""

from parallax import EngineComponent, Entity, PrefabRef, Vec3, component, event

@component("breakable")
class Breakable(EngineComponent):
    health: float = ...
    impact_threshold: float | None = ...
    """Newtons of contact force that deal 1 damage; None: impacts don't hurt it."""
    pieces: PrefabRef | None = ...
    """Spawned when it breaks: a pre-fractured prefab (fracture=0), or a 1 m unit-cube
    piece prefab scaled to fill its box collider (fracture=N); None: it just vanishes."""
    fracture: int = ...
    """0: spawn `pieces` once at its pose; N: N pieces from straight cuts of its box collider."""
    scatter: float = ...
    """m/s the pieces fly apart at, away from where it broke."""

    def damage(self, amount: float, *, source: Entity | None = None, point: Vec3 | None = None) -> None: ...
    def shatter(self, *, point: Vec3 | None = None, source: Entity | None = None) -> None:
        """Break it now, whatever its health."""

@event("breakable_damaged", target="entity")
class BreakableDamaged:
    entity: Entity
    amount: float
    source: Entity | None
    point: Vec3
    force: float
    """N of the impact; 0 for damage from code."""

@event("breakable_broken", target="entity")
class BreakableBroken:
    entity: Entity
    source: Entity | None
    point: Vec3
    force: float

class DestructionApi:
    def blast(self, center: Vec3, radius: float, damage: float, *, strength: float = 0,
              source: Entity | None = None) -> list[Entity]:
        """Damage breakables within `radius` (falling off linearly from `damage` at the
        centre) and, with `strength` (N·s), push every body as `ctx.physics.explode` does.
        Returns the breakables hit."""
