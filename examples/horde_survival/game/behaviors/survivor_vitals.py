from parallax import Behavior, SurfaceFx, behavior, on, vec3
from parallax.combat import Damaged, Died, Health
from project import Assets, Text

from game.blast import blast
from game.components import Build
from game.events import RunEnded
from game.rules import Rules, alert, play


@behavior("survivor_vitals", requires=[Health, Build])
class SurvivorVitals(Behavior):
    """The hurt sound (the flash, the shake scaled by the hit and the low-health pulse are
    the prefab's `hurt_feedback`), and the end of the ember: a drafted Second Wind relights
    it once at half and throws the pile back; otherwise the run is over."""

    @on(Damaged)
    def damaged(self, ctx, event: Damaged):
        play(ctx, ctx.config(Rules).sounds.hurt, gain=0.7)

    @on(Died)
    def died(self, ctx, event: Died):
        build = self.entity.get(Build)
        rules = ctx.config(Rules)
        if build.revives == 0:
            ctx.vfx.play(Assets.vfx.ember_out, at=self.entity.transform.position + vec3(0, 0.5, 0))
            self.entity.get(SurfaceFx).dissolve_to(1, rules.dissolve_seconds)
            ctx.emit(RunEnded(survived=False))
            return
        build.revives -= 1
        health = self.entity.get(Health)
        health.revive(health=health.max * rules.second_wind_health)
        health.protect(rules.second_wind_mercy)
        alert(ctx, ctx.text(Text.ember_rekindles), rules.alert_seconds)
        play(ctx, rules.sounds.rekindle)
        ctx.camera.main.shake(0.7, 0.4)
        blast(ctx, self.entity, max(build.nova_radius, rules.second_wind_radius), build.nova_damage)
