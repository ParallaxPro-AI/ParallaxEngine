"""Per-vehicle data."""

from parallax import component, field


@component("car_condition")
class CarCondition:
    """Crash damage from 0 (showroom) to 1 (wrecked)."""

    damage: float = field(0, min=0, max=1)
    crash_impulse: float = field(6000, min=0, unit="N·s", doc="Impacts softer than this do no damage.")
    fragility: float = field(0.00004, min=0, doc="Damage per unit of impulse above `crash_impulse`.")
