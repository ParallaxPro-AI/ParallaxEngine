"""Hurt barks for games with the combat plugin (library piece `barks`)."""

from parallax import System, on, system
from parallax.combat import Damaged

from game.lib.barks import Barker, say


@system("hurt_barks")
class HurtBarks(System):
    """A Barker that takes damage barks its "hurt" lines."""

    @on(Damaged, where=lambda e: e.entity.has(Barker))
    def hurt(self, ctx, e: Damaged):
        say(ctx, e.entity, "hurt")
