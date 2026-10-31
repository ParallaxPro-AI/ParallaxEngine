from parallax import Behavior, Collided, Vec3, behavior, on
from parallax.combat import Health
from project import Assets

from game.components import Cannonball, Ghost
from game.config import Sounds, VoyageRules


@behavior("cannonball", requires=[Cannonball])
class CannonballBehavior(Behavior):
    """A ball in flight: it holes the first enemy hull it hits and is lost to the sea
    when it comes down. Only the shooter's enemies take damage — no friendly fire."""

    def fixed_update(self, ctx, dt):
        here = self.entity.transform.position
        if here.y < ctx.config(VoyageRules).water_level:
            ctx.audio.play(Assets.sfx.splash, at=here, volume=0.4)
            ctx.vfx.play(Assets.vfx.splash, at=here)
            self.entity.destroy()

    @on(Collided)
    def struck(self, ctx, event):
        ball = self.entity.get(Cannonball)
        hull = event.target.try_get(Health)
        if hull is not None and ball.shooter.alive and ctx.combat.are_enemies(ball.shooter, event.target):
            hull.damage(ball.damage, source=ball.shooter, point=event.point)
            ctx.audio.play(ctx.config(Sounds).hull_hit, at=event.point)
            if event.target.has(Ghost):
                ctx.vfx.play(Assets.vfx.hull_sparks, at=event.target.transform.position + Vec3(0, 1, 0))
        self.entity.destroy()
