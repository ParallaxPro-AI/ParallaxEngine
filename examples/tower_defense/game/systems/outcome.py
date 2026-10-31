"""Winning and losing a battlefield."""

from parallax import System, on, system

from game.audio import Sounds
from game.components import BattlefieldScene
from game.config import SiegeRules
from game.events import EnemyLeaked, WaveCleared
from game.resources import Campaign, Purse, Result, Siege
from game.siege import current_level, playing


@system("outcome", scenes=[BattlefieldScene])
class Outcome(System):
    """The battlefield is lost when a leak takes the last life and won when its last
    wave is cleared. A win scores gold + lives + waves and earns stars for the lives
    kept. The result screen follows `Siege.result`."""

    @on(EnemyLeaked, when=playing)
    def overrun(self, ctx, event):
        if ctx.get(Purse).lives == 0:
            self.finish(ctx, won=False)

    @on(WaveCleared, when=playing)
    def last_wave(self, ctx, event):
        if event.number == len(current_level(ctx).waves):
            self.finish(ctx, won=True)

    def finish(self, ctx, won: bool):
        siege, purse, campaign, rules = ctx.get(Siege), ctx.get(Purse), ctx.get(Campaign), ctx.config(SiegeRules)
        siege.result = Result.WON if won else Result.LOST
        if won:
            kept = purse.lives / current_level(ctx).start_lives
            siege.stars = 3 if kept == 1 else 2 if kept >= rules.two_star_lives else 1
            siege.score = (
                purse.gold * rules.score_per_gold
                + purse.lives * rules.score_per_life
                + siege.wave * rules.score_per_wave
            )
            campaign.stars[campaign.level] = max(campaign.stars.get(campaign.level, 0), siege.stars)
        ctx.audio.play(ctx.config(Sounds).victory if won else ctx.config(Sounds).defeat)
