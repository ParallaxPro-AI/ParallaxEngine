"""Reading the world scene from anywhere: the player and the day."""

from parallax import Context, Entity
from project import Placed


def the_player(ctx: Context) -> Entity:
    return ctx.world.placed(Placed.player)


def day_number(ctx: Context) -> int:
    """Today, counting the first day as day 1 (`ctx.environment.day` counts days elapsed)."""
    return ctx.environment.day + 1


def hearts(total: int, left: int) -> list[dict]:
    """The expedition's lives as the template kit's pixel hearts (panel data)."""
    return [{"picture": "../assets/images/icons/heart.svg" if i < left else "../assets/images/icons/heart_empty.svg"}
            for i in range(total)]
