from parallax import ContentRef, Player
from parallax.net import rpc
from project import Text

from features.economy.components import Items, Wallet
from features.economy.shop import item_stats, quote
from features.fighting.feature import add_stats
from game.audio import Sounds, play
from game.config import MatchRules
from game.content import ItemDef


@rpc("buy_item", rate_limit=5)
def buy_item(ctx, player: Player, item: ContentRef[ItemDef]):
    """The shop's buy buttons: buy `item` for the player's champion, consuming owned components."""
    hero = player.entity
    wallet = hero.get(Wallet)
    items = hero.get(Items)
    offer = quote(item, items.owned)
    slots = ctx.config(MatchRules).item_slots
    if len(items.owned) - len(offer.consumed) + 1 > slots:
        ctx.ui.toast(ctx.text(Text.inventory_full, amount=slots), to=player)
        return
    if wallet.gold < offer.price:
        ctx.ui.toast(ctx.text(Text.need_more_gold, amount=offer.price - wallet.gold), to=player)
        return
    owned = list(items.owned)
    for part in offer.consumed:
        owned.remove(part)
    wallet.gold -= offer.price
    items.owned = owned + [item]
    add_stats(hero, item_stats(items.owned), key="items")
    play(ctx, ctx.config(Sounds).buy, to=player)
    message = Text.item_forged if offer.consumed else Text.item_bought
    ctx.ui.toast(ctx.text(message, item=ctx.text(item.data.name)), to=player)
