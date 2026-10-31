from parallax import Entity, component, field


@component("sight")
class Sight:
    """How far this unit sees for its team (champions, minions, towers, wards)."""
    radius: float = field(10, unit="m")


@component("ward_kit")
class WardKit:
    """A champion's wards. Filled at the start of the match; one charge returns
    every `MatchRules.ward_recharge` seconds."""
    charges: int = field(0, min=0, replicate="owner")
    charge_at: float = field(0, unit="s", replicate="owner", doc="When the next charge returns.")
    watchfires: int = field(0, min=0, replicate="owner", doc="Watchfires left to plant (no recharge).")
    hush_at: float = field(0, unit="s", replicate="owner", doc="When the Hushbell can ring again.")


@component("true_sight")
class TrueSight:
    """A vision source that sees into brush (Watchfires and the Hushbell's pulse)."""


@component("ward")
class Ward:
    """A placed ward (Picket or Watchfire): what a Hushbell breaks, and whose it is."""
    owner: Entity | None = field(None)
