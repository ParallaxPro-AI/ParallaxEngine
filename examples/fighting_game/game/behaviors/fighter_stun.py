from parallax import Behavior, behavior, on, param
from parallax.characters import Landed

from game.components import STUNNED, Fighter, FighterState


@behavior("fighter_stun", requires=[Fighter])
class FighterStun(Behavior):
    """Counts down hitstun, blockstun, knockdown and landing lag; when it runs out the
    fighter is neutral again and the combo against them is over. Unlike the moves it
    runs in every phase, so a combo counter still clears during the K.O. pause."""

    landing_lag: float = param(0.08, unit="s")

    def update(self, ctx, dt):
        fighter = self.entity.get(Fighter)
        fighter.stun_left = max(0.0, fighter.stun_left - dt)
        if fighter.stun_left == 0 and fighter.state in STUNNED:
            fighter.state = FighterState.NEUTRAL
            fighter.hits_in_combo = 0

    @on(Landed)
    def landed(self, ctx, event: Landed):
        fighter = self.entity.get(Fighter)
        if fighter.stun_left == 0 and fighter.move is None:
            fighter.state = FighterState.LANDING
            fighter.stun_left = self.landing_lag
