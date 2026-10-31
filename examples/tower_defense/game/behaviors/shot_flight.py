import math

from parallax import Behavior, Vec3, behavior, param, state, vec3

from game.attacks import land
from game.components import Shot


@behavior("shot_flight", requires=[Shot])
class ShotFlight(Behavior):
    """Flies a tower's shot to its target, following it if it moves and arcing if the
    shot lobs (cannon), then lands it at the target's last known spot."""

    speed: float = param(40, unit="m/s")
    arc_height: float = param(0, unit="m")
    aim_height: float = param(1, unit="m", doc="Height above the target's feet to aim for.")

    origin: Vec3 = state(Vec3.ZERO)
    aim: Vec3 = state(Vec3.ZERO)
    flight_time: float = state(0.0)
    elapsed: float = state(0.0)

    def start(self, ctx):
        self.origin = self.entity.transform.position
        self.follow_target()
        self.flight_time = max(0.05, self.origin.distance_to(self.aim) / self.speed)

    def update(self, ctx, dt):
        self.follow_target()
        self.elapsed += dt
        t = min(1.0, self.elapsed / self.flight_time)
        lift = vec3(0, math.sin(t * math.pi) * self.arc_height, 0)
        self.entity.transform.position = self.origin.lerp(self.aim, t) + lift
        if t == 1.0:
            land(ctx, self.entity.get(Shot), self.aim)
            self.entity.destroy()

    def follow_target(self):
        target = self.entity.get(Shot).target
        if target.alive:
            self.aim = target.transform.position + vec3(0, self.aim_height, 0)
