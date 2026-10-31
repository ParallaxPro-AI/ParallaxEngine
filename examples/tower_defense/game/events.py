"""Events."""

from parallax import Entity, event


@event("tower_upgraded", target="tower")
class TowerUpgraded:
    tower: Entity


@event("wave_start_requested")
class WaveStartRequested:
    """The HUD button and the hotkey. The `Waves` system owns the march it starts."""


@event("wave_cleared")
class WaveCleared:
    number: int
    boss: bool


@event("enemy_leaked", target="enemy")
class EnemyLeaked:
    enemy: Entity
