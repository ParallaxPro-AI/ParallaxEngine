from parallax import Behavior, Shape, behavior, param, vec3

from game.components import Turret
from game.resources import Build
from game.siege import stats, tower_on


@behavior("range_ring", requires=[Shape])
class RangeRing(Behavior):
    """Rings the selected pad. Its radius is the reach of the tower standing there, or of
    the armed tower that would be built there."""

    idle_radius: float = param(1.5, unit="m", doc="Size of the ring around an empty pad.")

    def update(self, ctx, dt):
        build = ctx.get(Build)
        self.entity.visible = build.selected is not None
        if build.selected is None:
            return
        tower = tower_on(build.selected)
        if tower is not None:
            turret = tower.get(Turret)
            radius = stats(turret.kind, turret.level).range
        elif build.armed is not None:
            radius = stats(build.armed, 1).range
        else:
            radius = self.idle_radius
        self.entity.transform.position = build.selected.transform.position.with_y(0.16)
        self.entity.transform.scale = vec3(radius * 2, 1, radius * 2)
