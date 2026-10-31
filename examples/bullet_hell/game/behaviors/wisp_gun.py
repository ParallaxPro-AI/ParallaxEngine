from parallax import Behavior, Color, Sprite, Timer, behavior, param, state, vec2
from project import Prefabs

from game.audio import Sounds, play
from game.components import Drift, Spark, Wisp
from game.content import Gun


@behavior("wisp_gun", requires=[Wisp])
class WispGun(Behavior):
    """Auto-fires seed-sparks upward. The bloom gun in hand sets the pattern (spread,
    rapid, piercing) and the build sets cadence, speed and Twin Bud's second barrel."""

    fire_gap: float = param(0.22, unit="s")
    rapid_gap: float = param(0.10, unit="s")
    min_gap: float = param(0.05, unit="s")
    muzzle: float = param(0.55, unit="m", doc="Sparks leave this far above the Wisp.")
    twin_offset: float = param(0.24, unit="m")
    spread_drift: float = param(2.5, unit="m/s", doc="Sideways speed of the spread gun's outer sparks.")
    twin_spread_offset: float = param(0.32, unit="m")
    twin_spread_drift: float = param(4.6, unit="m/s")
    pierce_color: Color = param(Color.hex("#c799ff"))

    cooldown: Timer = state(Timer.cooldown(0))

    def update(self, ctx, dt):
        self.cooldown.tick(dt)
        if not self.cooldown.done:
            return
        wisp = self.entity.get(Wisp)
        gap = self.rapid_gap if wisp.gun is Gun.RAPID else self.fire_gap
        self.cooldown.restart(max(self.min_gap, gap * wisp.fire_gap))
        muzzle = self.entity.transform.position.xy() + vec2(0, self.muzzle)
        for offset, drift in self.barrels(wisp.gun, wisp.twin > 0):
            spark = ctx.world.spawn(Prefabs.spark, at=muzzle + vec2(offset, 0),
                                    components=[Drift(velocity=vec2(drift, wisp.spark_speed)),
                                                Spark(pierce=wisp.gun is Gun.PIERCE)])
            if wisp.gun is Gun.PIERCE:
                spark.get(Sprite).color = self.pierce_color
        play(ctx, ctx.config(Sounds).spark)

    def barrels(self, gun: Gun, twin: bool) -> list[tuple[float, float]]:
        """(sideways offset, sideways speed) of every spark in one trigger pull."""
        if gun is Gun.SPREAD:
            shots = [(0.0, -self.spread_drift), (0.0, 0.0), (0.0, self.spread_drift)]
            if twin:
                shots += [(-self.twin_spread_offset, -self.twin_spread_drift),
                          (self.twin_spread_offset, self.twin_spread_drift)]
            return shots
        if twin:
            return [(-self.twin_offset, 0.0), (self.twin_offset, 0.0)]
        return [(0.0, 0.0)]
