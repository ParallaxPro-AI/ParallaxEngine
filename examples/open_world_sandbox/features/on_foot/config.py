"""What WASTED costs and where you wake up (config/street_rules.json)."""

from parallax import EntityRef, config, field


@config("street_rules")
class StreetRules:
    wasted_fine: float = field(0.1, min=0, max=1, doc="Fraction of cash lost on death.")
    wasted_seconds: float = field(3.5, min=0, unit="s")
    respawn: EntityRef = field(doc="Where the player wakes after WASTED.")
