"""Per-entity companion data."""

from parallax import TextRef, Timer, component, field


@component("companion")
class Companion:
    """A party member that follows the hero. `revive` counts down while it is knocked down."""

    name: TextRef = field()
    revive: Timer = field(Timer.cooldown(14))
