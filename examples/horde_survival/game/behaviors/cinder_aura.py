from parallax import Behavior, behavior, param, state

from game.components import Build


@behavior("cinder_aura", requires=[Build])
class CinderAura(Behavior):
    """Once drafted, everything standing in the survivor's heat burns a few times a second."""

    tick: float = param(0.25, unit="s")
    burn_at: float = state(0.0, doc="Game time of the next burn.")

    def update(self, ctx, dt):
        build = self.entity.get(Build)
        if build.aura_dps == 0 or ctx.time.now < self.burn_at:
            return
        self.burn_at = ctx.time.now + self.tick
        ctx.combat.area_damage(self.entity.transform.position, build.aura_radius, build.aura_dps * self.tick,
                               source=self.entity, falloff=False)
