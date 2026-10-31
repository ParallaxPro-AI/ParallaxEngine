import random

from parallax import System, on, system

from game.config import Rules
from game.content import UpgradeDef
from game.events import StageCleared, UpgradePicked
from game.resources import Draft, Mods


@system("upgrades")
class Upgrades(System):
    """Between stages, offers a few upgrades the player doesn't own yet and stacks
    the one they pick onto the run. `DraftPanel` is open while there is an offer."""

    @on(StageCleared, where=lambda event: not event.final)
    def offer(self, ctx, event: StageCleared):
        draft = ctx.get(Draft)
        pool = [u for u in ctx.content(UpgradeDef) if u not in draft.owned]
        draft.offer = random.sample(pool, min(ctx.config(Rules).draft_size, len(pool)))

    @on(UpgradePicked)
    def take(self, ctx, event: UpgradePicked):
        upgrade = event.upgrade.data
        mods = ctx.get(Mods)
        mods.paddle_width *= upgrade.paddle_width
        mods.paddle_speed *= upgrade.paddle_speed
        mods.english *= upgrade.english
        mods.ball_accel *= upgrade.ball_accel
        mods.ball_slow *= upgrade.ball_slow
        mods.score_mult *= upgrade.score_mult
        mods.extra_lives += upgrade.extra_lives

        draft = ctx.get(Draft)
        draft.owned.append(event.upgrade)
        draft.offer = []
