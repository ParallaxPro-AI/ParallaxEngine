from parallax import Behavior, Model, behavior, heading_to, on, param, state, vec3

from game.components import Invader, Shot, Turret
from game.events import TowerUpgraded
from game.siege import stats


@behavior("tower_turret", requires=[Turret, Model])
class TowerTurret(Behavior):
    """Turns to the nearest invader in range and fires its tower's shot at it.

    All five towers run this. What a shot does when it lands depends on the tower's
    `attack` and is decided in attacks.py."""

    muzzle_height: float = param(3.4, unit="m")

    ready_at: float = state(0.0)

    def update(self, ctx, dt):
        if ctx.time.now < self.ready_at:
            return
        turret = self.entity.get(Turret)
        level = stats(turret.kind, turret.level)
        position = self.entity.transform.position
        nearest = ctx.world.query(Invader).near(position, level.range).nearest(position)
        if nearest is None:
            return
        target, _ = nearest
        self.ready_at = ctx.time.now + level.fire_interval
        self.entity.transform.euler = vec3(0, heading_to(position, target.transform.position), 0)
        ctx.world.spawn(
            turret.kind.data.shot,
            at=position + vec3(0, self.muzzle_height, 0),
            components=[Shot(tower=turret.kind, level=turret.level, target=target)],
        )
        ctx.audio.play(turret.kind.data.fire_sound, at=self.entity, volume=0.22)

    @on(TowerUpgraded)
    def show_new_tier(self, ctx, event):
        turret = self.entity.get(Turret)
        self.entity.get(Model).model = stats(turret.kind, turret.level).model
