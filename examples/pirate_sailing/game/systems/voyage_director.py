import random

from parallax import SceneLoaded, System, on, system
from project import Text

from game.config import Sounds, VoyageRules
from game.content import UpgradeDef
from game.events import VoyageEnded
from game.resources import Ledger, Phase, Voyage
from game.rules import current_leg
from game.standing import shelf_bonus


@system("voyage_director")
class VoyageDirector(System):
    """The voyage's arc, run on the server for the whole fleet.

    Each leg opens in port with a refit draft dealt from the cards not yet maxed; the
    first captain to pick one fits it to every ship and starts the clock (the
    `pick_refit` RPC). The voyage ends when the crew or the sand runs out, or when the
    last leg is cleared."""

    @on(SceneLoaded)
    def open_port(self, ctx, event):
        voyage = ctx.get(Voyage)
        voyage.phase = Phase.REFIT
        voyage.offers = self.deal(ctx)
        ctx.ui.announce(current_leg(ctx).name, current_leg(ctx).brief, seconds=3)

    def deal(self, ctx):
        levels = ctx.get(Voyage).levels
        shelf = [u for u in ctx.content(UpgradeDef) if levels.get(u.id, 0) < u.data.max_level]
        # The chandlery's shelf is as wide as the Merchant Guild's regard for the fleet.
        offers = max(1, ctx.config(VoyageRules).refit_offers + shelf_bonus(ctx))
        return random.sample(shelf, min(offers, len(shelf)))

    @on(VoyageEnded)
    def end_voyage(self, ctx, event):
        voyage = ctx.get(Voyage)
        voyage.phase = Phase.ENDED
        voyage.won = event.won
        ledger = ctx.get(Ledger)
        ledger.gold += voyage.purse
        ledger.voyages_won += 1 if event.won else 0
        ledger.best_leg = max(ledger.best_leg, voyage.leg + 1)
        ctx.ui.announce(Text.voyage_won if event.won else Text.voyage_lost, seconds=3)
        ctx.audio.play(ctx.config(Sounds).win if event.won else ctx.config(Sounds).defeat)
