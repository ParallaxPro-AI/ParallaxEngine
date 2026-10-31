from parallax import Behavior, behavior, param, state

from game.components import Build, SoulMote
from game.events import XpGained
from game.rules import Rules, play, survivor


@behavior("soul_mote", requires=[SoulMote], tick="significance")
class SoulMoteDrift(Behavior):
    """Rests where its enemy fell until the survivor is within pickup reach, then
    accelerates into them and becomes XP."""

    acceleration: float = param(40, unit="m/s²")
    max_speed: float = param(30, unit="m/s")
    collect_distance: float = param(1.05, unit="m")
    speed: float = state(0.0)

    def update(self, ctx, dt):
        target = survivor(ctx)
        offset = target.transform.position - self.entity.transform.position
        distance = offset.length()
        if distance > target.get(Build).pickup_radius:
            self.speed = 0.0
            return
        if distance < self.collect_distance:
            ctx.emit(XpGained(amount=self.entity.get(SoulMote).xp))
            play(ctx, ctx.config(Rules).sounds.mote, gain=0.6)
            self.entity.destroy()
            return
        self.speed = min(self.max_speed, self.speed + self.acceleration * dt)
        self.entity.transform.position += offset / distance * min(distance, self.speed * dt)
