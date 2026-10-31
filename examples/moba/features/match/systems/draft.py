from parallax import System, system

from features.economy.feature import Wallet
from features.heroes.feature import Hero, equip_champion
from features.lanes.feature import WaveClock
from features.vision.feature import WardKit
from game.audio import excite
from game.config import MatchRules
from game.resources import Match, Phase


@system("draft", when=lambda ctx: ctx.get(Match).phase is Phase.DRAFT)
class Draft(System):
    """Ends the draft when every player has locked in or its clock runs out. Every
    champion, human or bot, is then equipped, given its starting gold and wards
    and released, and the first wave is scheduled."""

    def update(self, ctx, dt):
        match = ctx.get(Match)
        if all(p.entity.get(Hero).locked for p in ctx.players) or ctx.time.now >= match.draft_ends_at:
            self._begin(ctx, match)

    def _begin(self, ctx, match: Match):
        rules = ctx.config(MatchRules)
        match.phase = Phase.PLAYING
        match.started_at = ctx.time.now
        excite(ctx, 0.2)
        for hero, _, wallet, wards in ctx.world.query(Hero, Wallet, WardKit):
            equip_champion(ctx, hero)
            wallet.gold = rules.start_gold
            wards.charges = rules.ward_charges
            wards.watchfires = rules.watchfires
        ctx.get(WaveClock).next_in = rules.first_wave
