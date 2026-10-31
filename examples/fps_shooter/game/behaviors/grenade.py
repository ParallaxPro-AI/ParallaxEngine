from parallax import Behavior, Color, Entity, behavior, param
from parallax.physics import Rigidbody
from project import Assets, Prefabs

from game.audio import Sounds, play
from game.components import SmokeCloud


@behavior("grenade", requires=[Rigidbody])
class Grenade(Behavior):
    """A thrown grenade. It bounces around for its fuse, then goes off. A frag blasts
    everyone near it except the thrower's side, and the thrower gets the kills. A smoke
    grenade (`smoke` > 0) leaves a cloud that bots can neither see nor shoot through."""

    thrower: Entity | None = param(None)
    fuse: float = param(1.6, unit="s")
    radius: float = param(6, unit="m")
    damage: float = param(110, min=0)
    smoke: float = param(0, unit="s", doc="How long the cloud blocks sight; 0: a frag.")

    def start(self, ctx):
        ctx.time.after(self.fuse, lambda: self.explode(ctx))

    def explode(self, ctx):
        center = self.entity.transform.position
        if self.smoke > 0:
            ctx.world.spawn(Prefabs.smoke_cloud, at=center,
                            components=[SmokeCloud(radius=self.radius, clears_at=ctx.time.now + self.smoke)])
        else:
            ctx.combat.area_damage(center, self.radius, self.damage, source=self.thrower)
            ctx.physics.explode(center, self.radius, 8)
            ctx.vfx.play(Assets.vfx.frag_explosion, at=center)
            play(ctx, ctx.config(Sounds).frag_explode, at=center)
            ctx.hud.screen_flash(Color.hex("#ffd9a0"), strength=0.25, seconds=0.25)
            ctx.camera.main.shake(0.4, 0.3)
        self.entity.destroy()
