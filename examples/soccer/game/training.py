"""Team-talk training: the cards a won round deals, and what a picked card does.

A card's numbers become stat modifiers on the home squad, one modifier key per
pick, so a second pick of the same card stacks and no field keeps a copied "base".
The picks themselves live in `Cup.training` for the whole run; `apply_all` derives
the modifiers from that list, so it is safe to call again after any scene load."""

import random

from parallax import ContentRef, Context
from parallax.characters import Character

from game.components import Footballer, Goalkeeper, Home, Stamina
from game.content import CupRules, TrainingCard
from game.events import RoundStarted
from game.resources import Cup
from game.rules import outfield


def deal(ctx: Context) -> list[ContentRef[TrainingCard]]:
    """Random cards, skipping any already picked as often as it may stack."""
    cup = ctx.get(Cup)
    available = [card for card in ctx.content(TrainingCard)
                 if cup.training.count(card) < card.data.max_stacks]
    return random.sample(available, min(ctx.config(CupRules).offers, len(available)))


def pick(ctx: Context, card: ContentRef[TrainingCard]) -> None:
    """The team talk's panel action: take the card into the run, start the next round."""
    cup = ctx.get(Cup)
    cup.training.append(card)
    cup.offers = []
    cup.round += 1
    apply(ctx, card.data, key=f"training_{len(cup.training) - 1}")
    ctx.emit(RoundStarted(round=cup.round))


def apply_all(ctx: Context) -> None:
    """Every card picked this run, on the squad now on the pitch."""
    for index, card in enumerate(ctx.get(Cup).training):
        apply(ctx, card.data, key=f"training_{index}")


def apply(ctx: Context, card: TrainingCard, key: str) -> None:
    """Stack one card's bonuses on the home squad. Re-applying a key replaces it."""
    for player in outfield(ctx, Home):
        player.modify(Character, "walk_speed", add=card.control_speed, key=key)
        player.modify(Character, "run_speed", add=card.control_sprint, key=key)
        player.modify(Footballer, "ai_speed", add=card.mate_speed, key=key)
        player.modify(Footballer, "kick_power", add=card.kick_power, key=key)
        player.modify(Footballer, "pass_power", add=card.pass_power, key=key)
        player.modify(Footballer, "pass_range", add=card.pass_range, key=key)
        player.modify(Stamina, "max", add=card.stamina_max, key=key)
        player.modify(Stamina, "regen", add=card.stamina_regen, key=key)
        player.modify(Stamina, "rest_regen", add=card.stamina_regen, key=key)
    for keeper in ctx.world.query(Goalkeeper, tagged=Home).entities():
        keeper.modify(Footballer, "ai_speed", add=card.keeper_speed, key=key)
        keeper.modify(Goalkeeper, "reach", add=card.keeper_reach, key=key)


def kickoff_at_your_feet(ctx: Context) -> bool:
    """Set-Piece Work: every restart starts with the ball at your feet."""
    return any(card.data.kickoff_possession for card in ctx.get(Cup).training)


def fresh_legs_at_kickoff(ctx: Context) -> bool:
    """Physio Table: every kickoff refills the squad's stamina."""
    return any(card.data.fresh_start for card in ctx.get(Cup).training)
