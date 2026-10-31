from parallax import Behavior, ContentRef, EffectRef, Model, PrefabRef, Settings, Vec3, behavior, param, state, vec3
from parallax.combat import StatusEffectDef
from parallax.grid import GridCell
from project import Assets, Prefabs

from game.components import Husk, Planted
from game.resources import Irrigation
from game.audio import Sounds, play


@behavior("lane_shooter", requires=[Planted, GridCell])
class LaneShooter(Behavior):
    """Shoots thorns down its own lane while a husk is in range ahead of it.

    Thornspitter, Twinthorn (`volley: 2`) and Rimecap (chilling thorns) are this
    one behavior with different params. A watered row fires faster.
    """

    thorn: PrefabRef = param(Prefabs.thorn)
    damage: float = param(22, min=0)
    range: float = param(14, unit="m")
    fire_interval: float = param(1.5, min=0.1, unit="s")
    volley: int = param(1, min=1, doc="Thorns per shot.")
    volley_gap: float = param(0.16, unit="s")
    chill: ContentRef[StatusEffectDef] | None = param(None, doc="Status effect a hit applies.")
    chill_seconds: float = param(0, unit="s")
    watered_fire_rate: float = param(1.35, min=1)
    muzzle: Vec3 = param(vec3(0.4, 0.72, 0), unit="m")
    flash: EffectRef = param(Assets.vfx.thorn_muzzle, doc="Sparks at the muzzle per thorn.")

    ready_at: float = state(0.0)

    def update(self, ctx, dt):
        if ctx.time.now < self.ready_at or not self.husk_ahead(ctx):
            return
        watered = ctx.get(Irrigation).row == self.lane()
        self.ready_at = ctx.time.now + self.fire_interval / (self.watered_fire_rate if watered else 1)
        for shot in range(self.volley):
            ctx.time.after(shot * self.volley_gap, lambda: self.fire(ctx))

    def lane(self) -> int:
        return self.entity.get(GridCell).cell.row

    def husk_ahead(self, ctx) -> bool:
        lane, x = self.lane(), self.entity.transform.position.x
        return any(
            husk.lane == lane and 0 < entity.transform.position.x - x <= self.range
            for entity, husk in ctx.world.query(Husk)
        )

    def fire(self, ctx):
        muzzle = self.entity.transform.position + self.muzzle
        ctx.world.spawn(
            self.thorn,
            at=muzzle,
            params={"thorn": {
                "damage": self.damage,
                "range": self.range,
                "chill": self.chill,
                "chill_seconds": self.chill_seconds,
            }},
        )
        ctx.vfx.play(self.flash, at=muzzle + vec3(0.15, 0, 0))
        play(ctx, ctx.config(Sounds).thorn_shoot, at=self.entity)
        if not ctx.get(Settings).reduced_motion:
            model = self.entity.get(Model)
            model.pose("recoil", 0.16)
            model.pose("recoil", 0, seconds=0.28, ease="out_quad")
