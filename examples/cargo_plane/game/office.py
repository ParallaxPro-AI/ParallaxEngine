"""The office panel's actions: sign a contract off the board, or buy a hangar upgrade.
Each parameter is filled from the clicked card."""

from parallax import Context, ContentRef
from project import Text

from game.board import sign
from game.content import UpgradeDef
from game.cues import Cues, play
from game.feed import Kind, say
from game.resources import Board, Career
from game.rules import upgrade_price


def take_contract(ctx: Context, offer: int) -> None:
    """Sign the board's offer at index `offer`, unless a load is already aboard."""
    board = ctx.get(Board)
    if board.loaded:
        return
    signed = board.offers[offer]
    sign(ctx, signed)
    board.pad_lock = False  # signed for it: the loaders start putting it aboard
    play(ctx, ctx.config(Cues).signed)
    say(ctx, ctx.text(Text.contract_signed, cargo=ctx.text(signed.cargo.data.name),
                      island=ctx.text(signed.destination.data.name)))


def buy_upgrade(ctx: Context, upgrade: ContentRef[UpgradeDef]) -> None:
    """Fit the next tier, if the hangar sells one and the bank covers it."""
    career = ctx.get(Career)
    price = upgrade_price(ctx, upgrade)
    if price is None:
        return
    if career.money < price:
        say(ctx, ctx.text(Text.not_enough_money), Kind.BAD)
        return
    career.money -= price
    career.upgrades[upgrade.id] = career.upgrades.get(upgrade.id, 0) + 1
    play(ctx, ctx.config(Cues).upgrade)
    say(ctx, ctx.text(Text.upgrade_fitted, upgrade=ctx.text(upgrade.data.name)), Kind.GOOD)
    ctx.save.save("career")
