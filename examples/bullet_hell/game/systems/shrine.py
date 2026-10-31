import random

from parallax import System, on, system

from game.build import stacks
from game.config import Build
from game.content import UpgradeDef
from game.events import UpgradePicked, WaveCleared
from game.resources import Shrine


@system("shrine")
class ShrineDraft(System):
    """After every wave but the last, the shrine offers a few attunements not yet at
    their stack limit. The one taken is permanent for the run. `ShrinePanel` is open
    while there is an offer."""

    @on(WaveCleared, where=lambda event: not event.final)
    def offer(self, ctx, event: WaveCleared):
        pool = [u for u in ctx.content(UpgradeDef) if stacks(ctx, u) < u.data.max_stacks]
        ctx.get(Shrine).offer = random.sample(pool, min(ctx.config(Build).shrine_offers, len(pool)))

    @on(UpgradePicked)
    def take(self, ctx, event: UpgradePicked):
        shrine = ctx.get(Shrine)
        shrine.taken.append(event.upgrade)
        shrine.offer = []
