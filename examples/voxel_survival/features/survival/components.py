from parallax import component, field


@component("vitals")
class Vitals:
    """The survival meters besides health (which is the combat plugin's Health)."""
    hunger: float = field(100, min=0)
    max_hunger: float = field(100, min=1)
    air: float = field(12, min=0, unit="s")
    max_air: float = field(12, min=0, unit="s")
