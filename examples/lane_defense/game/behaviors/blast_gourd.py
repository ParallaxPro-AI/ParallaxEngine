from parallax import Behavior, Settings, behavior, param
from project import Assets
from game.audio import Sounds, play


@behavior("blast_gourd")
class BlastGourd(Behavior):
    """Swells for a short fuse after planting, then blasts every husk around it and is
    used up. Its Side keeps the blast off neighboring plants."""

    fuse: float = param(1.2, unit="s")
    radius: float = param(2.4, unit="m")
    damage: float = param(1800, min=0)
    swell: float = param(1.07, doc="Scale reached as the fuse runs out.")

    def start(self, ctx):
        if not ctx.get(Settings).reduced_motion:
            self.entity.transform.scale_to(self.swell, self.fuse, ease="linear")
        ctx.time.after(self.fuse, lambda: self.detonate(ctx))

    def detonate(self, ctx):
        center = self.entity.transform.position
        ctx.combat.area_damage(center, self.radius, self.damage, source=self.entity, falloff=False)
        ctx.vfx.play(Assets.vfx.explosion, at=center.with_y(1.0))
        play(ctx, ctx.config(Sounds).gourd_boom)
        if not ctx.get(Settings).reduced_motion:
            ctx.camera.main.shake(0.18, 0.18)
        self.entity.destroy()
