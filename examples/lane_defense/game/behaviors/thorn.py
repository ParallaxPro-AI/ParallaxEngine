from parallax import Behavior, Color, ContentRef, EffectRef, TriggerEntered, Vec3, behavior, on, param, state
from parallax.combat import Health, StatusEffectDef, StatusEffects
from parallax.physics import Rigidbody
from project import Assets
from game.audio import Sounds, play


@behavior("thorn", requires=[Rigidbody])
class Thorn(Behavior):
    """A thorn flying down its lane. It hurts the first husk it touches (its collider only
    collides with husks), chills it if this is a rime thorn, and is gone."""

    speed: float = param(9, unit="m/s")
    range: float = param(14, unit="m")
    damage: float = param(22, min=0)
    chill: ContentRef[StatusEffectDef] | None = param(None)
    chill_seconds: float = param(0, unit="s")
    impact: EffectRef = param(Assets.vfx.thorn_hit)
    trail: Color = param(Color.hex("#7ced95"), doc="The template's Trail: 0.13 m wide, 0.22 s long.")

    spent: bool = state(False, doc="Already hit a husk this step.")

    def start(self, ctx):
        self.entity.get(Rigidbody).velocity = Vec3.RIGHT * self.speed
        self.entity.destroy(after=self.range / self.speed)
        ctx.vfx.trail(self.entity, color=self.trail, width=0.13, seconds=0.22, glow=True)

    @on(TriggerEntered)
    def hit(self, ctx, event):
        if self.spent:
            return
        self.spent = True
        husk = event.target
        husk.get(Health).damage(self.damage, source=self.entity)
        spot = husk.transform.position
        ctx.vfx.play(self.impact, at=spot.with_y(self.entity.transform.position.y))
        if self.chill is not None and husk.get(Health).current > 0:
            husk.get(StatusEffects).apply(self.chill, self.chill_seconds, source=self.entity)
            ctx.vfx.play(Assets.vfx.chill, at=spot.with_y(1.2))
        play(ctx, ctx.config(Sounds).thorn_hit, at=husk)
        self.entity.destroy()
