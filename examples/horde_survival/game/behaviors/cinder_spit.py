import random

from parallax import Behavior, PrefabRef, behavior, param, state, vec3

from game.components import Shot
from game.rules import Rules, play, survivor


@behavior("cinder_spit")
class CinderSpit(Behavior):
    """A spitter plants itself at range and lobs a cinder shard on an interval."""

    shard: PrefabRef = param()
    damage: float = param(9)
    interval: float = param(2.3, unit="s")
    reach: float = param(23, unit="m")
    speed: float = param(15, unit="m/s")
    muzzle_height: float = param(1.4, unit="m")
    ready_at: float = state(0.0, doc="Game time of the next shard.")

    def start(self, ctx):
        # Staggered, or a surge of spitters volleys in lockstep.
        self.ready_at = ctx.time.now + self.interval * random.uniform(0.5, 1.5)

    def update(self, ctx, dt):
        here = self.entity.transform.position
        target = survivor(ctx).transform.position
        if ctx.time.now < self.ready_at or here.distance_to(target) > self.reach:
            return
        self.ready_at = ctx.time.now + self.interval
        aim = (target - here).flat().normalized()
        ctx.world.spawn(self.shard, at=here + vec3(0, self.muzzle_height, 0),
                        components=[Shot(velocity=aim * self.speed, damage=self.damage)])
        play(ctx, ctx.config(Rules).sounds.spit, gain=0.5)
