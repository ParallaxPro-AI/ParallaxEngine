from parallax import System, system
from project import Text

from game.config import Deed, Sounds

from game.events import VoyageEnded
from game.resources import Phase, Voyage
from game.rules import current_leg, is_last_leg, sailing
from game.standing import record_deed


@system("leg_clock", when=sailing)
class LegClock(System):
    """Runs the sand while the fleet is at sea. Fill the hold to the leg's quota and
    honour its bounty before it runs out to sail on to the next sea; clear the last leg
    and the voyage is won; run out of time and it is lost."""

    def update(self, ctx, dt):
        voyage = ctx.get(Voyage)
        leg = current_leg(ctx)
        voyage.time_left = max(0.0, voyage.time_left - dt)
        if voyage.leg_gold >= leg.gold_quota and voyage.bounty >= leg.bounty_count:
            self.clear_leg(ctx)
        elif voyage.time_left == 0:
            ctx.emit(VoyageEnded(won=False))

    def clear_leg(self, ctx):
        record_deed(ctx, Deed.LEG_CLEARED)
        ctx.audio.play(ctx.config(Sounds).leg_cleared, volume=0.55)
        if is_last_leg(ctx):
            ctx.emit(VoyageEnded(won=True))
            return
        voyage = ctx.get(Voyage)
        voyage.phase = Phase.REFIT
        voyage.leg += 1
        ctx.ui.announce(Text.leg_cleared)
        ctx.scenes.load(current_leg(ctx).scene)
