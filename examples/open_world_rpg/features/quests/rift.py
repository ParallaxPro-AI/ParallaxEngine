"""Whether the Shadow Rift's clock is running."""

from parallax import Context

from features.quests.resources import Doom, Ending, Outcome


def rift_running(ctx: Context) -> bool:
    return not ctx.get(Doom).clock.done and ctx.get(Outcome).ending is Ending.NONE
