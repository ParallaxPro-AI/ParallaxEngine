from parallax import Behavior, behavior, param, state
from parallax.combat import Health

from game.components import Fighter


@behavior("health_trail", requires=[Fighter, Health])
class HealthTrail(Behavior):
    """The pale strip behind a health bar: it holds what a hit took for a moment, then
    drains down to the health that is left. A heal or a new round snaps it up."""

    hold: float = param(0.45, unit="s", doc="How long the trail waits after a hit.")
    drain: float = param(0.6, unit="1/s", doc="Health fraction per second it drains.")
    last_health: float = state(1.0)
    drain_from: float = state(0.0, doc="Game time the trail may start draining.")

    def update(self, ctx, dt):
        fighter = self.entity.get(Fighter)
        health = self.entity.get(Health).fraction
        if health < self.last_health:
            self.drain_from = ctx.time.now + self.hold
        self.last_health = health
        if health >= fighter.trail:
            fighter.trail = health
        elif ctx.time.now >= self.drain_from:
            fighter.trail = max(health, fighter.trail - self.drain * dt)
