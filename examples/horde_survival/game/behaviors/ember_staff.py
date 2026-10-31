from parallax import Behavior, behavior, param, state, vec3
from project import Prefabs

from game.components import Bolt, Build, Horde
from game.rules import Rules, play


@behavior("ember_staff", requires=[Build])
class EmberStaff(Behavior):
    """Fires on its own: every interval, one bolt at each of the nearest enemies in range."""

    muzzle_height: float = param(1.2, unit="m")
    ready_at: float = state(0.0, doc="Game time the staff may fire again.")

    def update(self, ctx, dt):
        if ctx.time.now < self.ready_at:
            return
        build = self.entity.get(Build)
        here = self.entity.transform.position
        targets = ctx.world.query(tagged=Horde).near(here, build.bolt_range).nearest(here, build.bolts)
        if not targets:
            return
        self.ready_at = ctx.time.now + build.fire_interval
        muzzle = here + vec3(0, self.muzzle_height, 0)
        for target in targets:
            aim = (target.transform.position - here).flat().normalized()
            ctx.world.spawn(Prefabs.ember_bolt, at=muzzle, components=[
                Bolt(velocity=aim * build.bolt_speed, damage=build.damage, pierce=build.pierce,
                     hit_radius=build.hit_radius),
            ])
        play(ctx, ctx.config(Rules).sounds.bolt)
