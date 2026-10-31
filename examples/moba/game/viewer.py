"""Whose screen this is (panels)."""

from parallax import Context, Entity


def my_hero(ctx: Context) -> Entity | None:
    """The champion of the player looking at this screen, or None before the server
    has given them one."""
    me = ctx.net.local_player
    return me.entity if me else None
