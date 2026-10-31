"""The run up the ladder: tip-off against tonight's crew, and the locker room's perks.

A perk's numbers become stat modifiers, one modifier key per card taken, so a second
copy stacks and no rule sums perks at the point of use. The cards themselves live in
`Run.perks` for the whole run; `apply_perks` derives the modifiers from that list,
so it is safe to call again after any scene load."""

import random

from parallax import ContentRef, Context
from parallax.characters import Character
from project import Placed

from game.components import Away, Ball, Bot, Edge, Meter, Stamina
from game.content import CourtRules, Perk
from game.resources import Match, Run
from game.rules import crew, you


def tip_off(ctx: Context) -> None:
    """A fresh game, with the away bots playing as tonight's crew (speed, style of play;
    the crew colour tints the HUD, the kit stays black and gold as in the original). The
    game clock opens the first quarter on its next tick."""
    tonight = crew(ctx)
    ctx.reset(Match)
    for _, bot, character in ctx.world.query(Bot, Character, tagged=Away):
        bot.style = tonight.style
        character.walk_speed = tonight.speed


def deal(ctx: Context) -> list[ContentRef[Perk]]:
    """Random cards, skipping any already taken as often as it may stack."""
    run = ctx.get(Run)
    available = [card for card in ctx.content(Perk) if run.perks.count(card) < card.data.max_stacks]
    return random.sample(available, min(ctx.config(CourtRules).offers, len(available)))


def pick(ctx: Context, card: ContentRef[Perk]) -> None:
    """The locker room's panel action: take the card, then tip off against the next crew."""
    run = ctx.get(Run)
    run.perks.append(card)
    run.offers = []
    run.stage += 1
    apply_perk(ctx, card.data, key=f"perk_{len(run.perks) - 1}")
    tip_off(ctx)


def apply_perks(ctx: Context) -> None:
    """Every card taken this run, on the ballers now on the court."""
    for index, card in enumerate(ctx.get(Run).perks):
        apply_perk(ctx, card.data, key=f"perk_{index}")


def apply_perk(ctx: Context, perk: Perk, key: str) -> None:
    """Stack one card on you, your running mate and the ball. Re-applying a key replaces it."""
    yours, mate = you(ctx), ctx.world.placed(Placed.mate)
    ball, _ = ctx.world.query(Ball).single()
    yours.modify(Character, "walk_speed", add=perk.speed, key=key)
    yours.modify(Character, "run_speed", add=perk.speed, key=key)
    yours.modify(Stamina, "max", add=perk.stamina_max, key=key)
    yours.modify(Stamina, "regen", add=perk.stamina_regen, key=key)
    yours.modify(Meter, "green_low", add=perk.green_low, key=key)
    yours.modify(Meter, "green_high", add=perk.green_high, key=key)
    yours.modify(Edge, "three_bonus", add=perk.three_bonus, key=key)
    yours.modify(Edge, "clutch_bonus", add=perk.clutch_bonus, key=key)
    yours.modify(Edge, "contest_relief", add=perk.contest_relief, key=key)
    yours.modify(Edge, "steal_chance", add=perk.steal_chance, key=key)
    yours.modify(Edge, "steal_range", add=perk.steal_range, key=key)
    yours.modify(Edge, "steal_cooldown", add=perk.steal_cooldown, key=key)
    yours.modify(Edge, "pickup_radius", add=perk.pickup_radius, key=key)
    mate.modify(Edge, "make_bonus", add=perk.ally_make_bonus, key=key)
    ball.modify(Ball, "pass_speed", add=perk.pass_speed, key=key)
