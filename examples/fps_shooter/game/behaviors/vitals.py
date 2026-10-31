from parallax import Behavior, behavior, on, state
from parallax.combat import Damaged, Health

from game.config import MatchRules


@behavior("vitals", requires=[Health])
class Vitals(Behavior):
    """Regeneration: a few seconds after the last hit, health climbs back. (The hit
    flash, shake and direction arc are the player's HurtFeedback; plating is a damage
    modifier.)"""

    last_hit_at: float = state(-100.0)

    def update(self, ctx, dt):
        rules = ctx.config(MatchRules)
        health = self.entity.get(Health)
        if not health.dead and ctx.time.now - self.last_hit_at >= rules.regen_delay:
            health.heal(rules.regen_rate * dt)

    @on(Damaged)
    def hurt(self, ctx, event):
        self.last_hit_at = ctx.time.now
