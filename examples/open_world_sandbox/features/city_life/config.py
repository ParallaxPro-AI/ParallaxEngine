"""What the street pays and how it reacts (config/street.json). How many people and cars there are
is the scene's `"city"` block (`pedestrians`, `traffic`)."""

from parallax import config, field


@config("street")
class Street:
    cash_per_kill_min: int = field(5, min=0)
    cash_per_kill_max: int = field(25, min=0)
    run_over_damage: float = field(0.004, doc="Damage per unit of collision impulse.")
    panic_radius: float = field(30, unit="m", doc="City pedestrians this close to gunfire or a hurt person run.")
    panic_seconds: float = field(8, unit="s")
