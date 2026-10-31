"""The realm's economic rules (config/economy.json)."""

from parallax import config, field


@config("economy")
class Economy:
    """What falling costs and when F reaches for mana instead of health."""

    death_toll: float = field(0.15, min=0, max=1, doc="Fraction of the purse lost when the hero falls.")
    mana_potion_below: float = field(30, min=0, doc="Missing mana that makes F reach for a mana potion first.")
