"""Choosing a battlefield and marching out to it. `enter_level` and `battle` are panel
actions; `battle` is also Retry."""

from parallax import Context, ContentRef

from game.content import LevelDef
from game.resources import Campaign, Purse
from game.siege import current_level


def is_unlocked(ctx: Context, level: ContentRef[LevelDef]) -> bool:
    """A battlefield opens once the one before it has been cleared."""
    gate = level.data.unlocked_by
    return gate is None or ctx.get(Campaign).stars.get(gate, 0) > 0


def enter_level(ctx: Context, level: ContentRef[LevelDef]) -> None:
    """A chapter card: pick its battlefield and march out to it."""
    if is_unlocked(ctx, level):
        ctx.get(Campaign).level = level
        battle(ctx)


def battle(ctx: Context) -> None:
    """Load the picked battlefield fresh, with its starting gold and lives."""
    level = current_level(ctx)
    ctx.scenes.load(level.scene, new_run=True, init=[Purse(gold=level.start_gold, lives=level.start_lives)])
