"""The chapter's gardens in order: each opens once the one before it is cleared.
`choose_level`, `replant` and `plant_next_garden` are panel actions."""

from parallax import Context, ContentRef
from project import Scenes

from game.config import GardenRules
from game.content import LevelDef
from game.resources import Campaign, GardenState, Pollen


def next_garden(ctx: Context, level: ContentRef[LevelDef]) -> ContentRef[LevelDef] | None:
    return ctx.content(LevelDef).next(level)


def is_unlocked(ctx: Context, level: ContentRef[LevelDef]) -> bool:
    gardens = ctx.content(LevelDef)
    index = gardens.index(level)
    return index == 0 or ctx.get(Campaign).stars.get(gardens[index - 1], 0) > 0


def choose_level(ctx: Context, level: ContentRef[LevelDef]) -> None:
    """Pick a garden on the title screen. Locked ones can't be picked."""
    if is_unlocked(ctx, level):
        ctx.get(Campaign).level = level


def replant(ctx: Context) -> None:
    """Start the chosen garden fresh: its starting pollen and a whole house. Also Retry."""
    level = ctx.get(Campaign).level.data
    ctx.scenes.load(Scenes.garden, new_run=True, init=[
        Pollen(amount=level.start_pollen),
        GardenState(house_health=ctx.config(GardenRules).house_health),
    ])


def plant_next_garden(ctx: Context) -> None:
    """After a win: move on to the next garden of the chapter."""
    campaign = ctx.get(Campaign)
    campaign.level = next_garden(ctx, campaign.level)
    replant(ctx)
