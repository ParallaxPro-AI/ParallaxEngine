"""Prices, buying, and the permanent bonuses the merchant has sold."""

from parallax import Context, ContentRef
from project import Text

from features.hero.feature import Progression
from features.inventory.bag import give
from features.inventory.content import Stat, WareDef
from features.inventory.resources import Purse, Upgrades
from game.audio import Sounds, play
from game.feed import Kind, announce


def price_of(ctx: Context, ware: ContentRef[WareDef]) -> int:
    """The base price plus one `price_step` per previous purchase."""
    return ware.data.price + ware.data.price_step * ctx.get(Upgrades).bought.get(ware, 0)


def can_buy(ctx: Context, ware: ContentRef[WareDef]) -> bool:
    return ctx.get(Progression).level >= ware.data.min_level and ctx.get(Purse).gold >= price_of(ctx, ware)


def buy(ctx: Context, ware: ContentRef[WareDef]) -> None:
    """The shop's buy button: checks level and gold, takes the gold, then hands over the ware."""
    if not can_buy(ctx, ware):
        return
    price = price_of(ctx, ware)
    ctx.get(Purse).gold -= price
    bought = ctx.get(Upgrades).bought
    bought[ware] = bought.get(ware, 0) + 1
    if ware.data.item is not None:
        give(ctx, ware.data.item)
    announce(ctx, ctx.text(ware.data.name), Kind.BOUGHT, ctx.text(Text.price_paid, price=price))
    play(ctx, ctx.config(Sounds).purchase)


def upgrade_bonus(ctx: Context, stat: Stat) -> float:
    """The total a stat has been raised by everything bought so far."""
    return sum(
        ware.data.amount * count
        for ware, count in ctx.get(Upgrades).bought.items()
        if ware.data.stat is stat
    )
