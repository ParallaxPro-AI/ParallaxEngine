"""Per-entity data on the hero."""

from parallax import Timer, component, field, tag

Hero = tag("hero")


@component("mana")
class Mana:
    """The pool abilities spend."""

    current: float = field(100, min=0)
    max: float = field(100, min=0)


@component("dodge")
class Dodge:
    """The dodge roll's recharge, on the hero so the HUD's ability dock can show it."""

    ready: Timer = field(Timer.cooldown(0.9))
