from parallax import Behavior, behavior, param, state, vec3
from project import Prefabs

from game.actions import Controls
from game.components import Projectile
from game.resources import Run
from game.rules import Rules, Sounds


@behavior("shard_shooter")
class ShardShooter(Behavior):
    """Fires bone shards in the direction of the shoot stick, at the run's fire rate."""

    muzzle_height: float = param(0.6, unit="m")
    ready_at: float = state(0.0, doc="Game time the next shard may fire.")

    def update(self, ctx, dt):
        aim = ctx.input.axis(Controls.shoot)
        if ctx.time.now < self.ready_at or aim.length() == 0:
            return
        run = ctx.get(Run)
        self.ready_at = ctx.time.now + run.fire_interval
        direction = ctx.camera.main.relative(aim).normalized()
        ctx.world.spawn(
            Prefabs.shard,
            at=self.entity.transform.position + vec3(0, self.muzzle_height, 0),
            components=[Projectile(velocity=direction * run.shard_speed, damage=run.shard_damage,
                                   lifetime=ctx.config(Rules).shard_lifetime)],
        )
        ctx.audio.play(ctx.config(Sounds).shard_fire, volume=0.6)
