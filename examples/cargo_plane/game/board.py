"""The contract board: rolling offers at an island and quoting what they pay."""

import random

from parallax import Context, ContentRef

from game.config import FreightRules
from game.content import CargoDef, IslandDef
from game.resources import Board, Offer
from game.rules import depot, pay_multiplier, reached


def roll_offers(ctx: Context, island: ContentRef[IslandDef]) -> None:
    """Deal the board at `island`: a few loads to islands the pilot's rank allows,
    each to a different destination while there are enough to go round. The first offer
    goes straight on the manifest, so a pilot who never opens the office always has a
    job to fly."""
    destinations = [i for i in ctx.content(IslandDef) if i != island and reached(ctx, i.data.min_rank)]
    loads = [c for c in ctx.content(CargoDef) if reached(ctx, c.data.min_rank)]
    random.shuffle(destinations)
    board = ctx.get(Board)
    board.island = island
    board.offers = [quote(ctx, random.choice(loads), island, destinations[i % len(destinations)])
                    for i in range(ctx.config(FreightRules).offers)]
    sign(ctx, board.offers[0])


def quote(ctx: Context, cargo: ContentRef[CargoDef], origin: ContentRef[IslandDef],
          destination: ContentRef[IslandDef]) -> Offer:
    rules = ctx.config(FreightRules)
    leg = (depot(ctx, destination).transform.position - depot(ctx, origin).transform.position).flat().length()
    slack = rules.urgent_slack if cargo.data.urgent else rules.deadline_slack
    pay = (rules.pay_base + leg * rules.pay_per_metre) * cargo.data.pay_scale * pay_multiplier(ctx)
    return Offer(cargo=cargo, origin=origin, destination=destination, leg=leg, pay=round(pay),
                 deadline=round(rules.deadline_base + leg / rules.cruise_speed * slack))


def sign(ctx: Context, offer: Offer) -> None:
    board = ctx.get(Board)
    board.contract = offer
    board.loaded = board.late = board.damaged = board.greased = False
