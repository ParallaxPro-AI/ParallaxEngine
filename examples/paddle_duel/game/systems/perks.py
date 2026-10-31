import random

from parallax import System, on, system

from game.config import Rules
from game.content import PerkDef
from game.events import DuelWon, PerkPicked
from game.resources import Draft, Mods


@system("perks")
class Perks(System):
    """After each duel won (except the last), offers a few perks the player doesn't
    own yet and stacks the one they pick onto the run. `DraftPanel` is open while
    there is an offer."""

    @on(DuelWon, where=lambda event: not event.final)
    def offer(self, ctx, event: DuelWon):
        draft = ctx.get(Draft)
        pool = [p for p in ctx.content(PerkDef) if p not in draft.owned]
        draft.offer = random.sample(pool, min(ctx.config(Rules).draft_size, len(pool)))

    @on(PerkPicked)
    def take(self, ctx, event: PerkPicked):
        perk = event.perk.data
        mods = ctx.get(Mods)
        mods.paddle_length *= perk.paddle_length
        mods.paddle_speed *= perk.paddle_speed
        mods.english *= perk.english
        mods.charge_boost *= perk.charge_boost
        mods.charge_rate *= perk.charge_rate
        mods.rally_score *= perk.rally_score
        mods.return_speed *= perk.return_speed
        mods.ball_accel *= perk.ball_accel
        mods.shields += perk.shields

        draft = ctx.get(Draft)
        draft.owned.append(event.perk)
        draft.offer = []
