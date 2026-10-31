"""Per-entity data and tags."""

from parallax import ContentRef, component, field, tag

from game.content import EnemyTankDef

BattlefieldScene = tag("battlefield")
"""Scene tag of the four battlefields: where the battle systems, controls and pause exist."""
PlayerTank = tag("player_tank")
Allies = tag("allies")
Axis = tag("axis")
FireControlZone = tag("fire_control_zone")
"""The control point: your gun hits harder while you hold it."""
Explosive = tag("explosive")
"""Fuel drums: any shell bursting within the trigger radius cooks one off."""
Shellfire = tag("shellfire")
"""Damage kind of every tank shell."""
Blast = tag("blast")
"""Damage kind of fuel-drum and HE-wreck blasts: they ignore armor, as in the template."""


@component("gunnery")
class Gunnery:
    """The player's ready rack and repair kit (shown on the HUD; refilled by ammo crates)."""

    ammo: int = field(0)
    capacity: int = field(0, doc="Ready-rack size, including upgrades.")
    reload_done_at: float = field(-1, unit="s", doc="-1 when not reloading.")
    repair_ready_at: float = field(0, unit="s")
    reload_seconds: float = field(1, unit="s", doc="Length of the reload in progress (the HUD's bar).")
    repair_seconds: float = field(1, unit="s", doc="Length of the repair cooldown (the HUD's bar).")


@component("enemy_tank")
class EnemyTank:
    """An enemy hull: its tier and its boss phase."""

    kind: ContentRef[EnemyTankDef] = field()
    phase: int = field(0, doc="Index into kind.data.phases (bosses only).")
    flank: int = field(1, choices=[-1, 1], doc="Which way a flanker circles.")


@component("grounded")
class Grounded:
    """A placed prop that sits on the terrain: the Grounding system drops it there at load."""

    lift: float = field(0, unit="m", doc="Height of its origin above the ground (half a centered shape).")
