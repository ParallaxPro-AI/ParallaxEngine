import math

from parallax import Behavior, behavior, param, state, vec3
from project import Placed


@behavior("versus_camera")
class VersusCamera(Behavior):
    """The original's side-on camera: it centres between the fighters, pulls back as they
    part (never closer than `min_distance`), and looks at chest height on the fight line.
    It stands on the ring's open side (-z). Time is frozen under the title card, so the
    scene places the camera where this would put it at rest (its placement in scenes/arena/scene.json)."""

    height: float = param(2.5, unit="m")
    look_height: float = param(1.2, unit="m")
    min_distance: float = param(6.8, unit="m")
    gap_padding: float = param(3.5, unit="m", doc="Added to the fighters' gap before scaling.")
    distance_per_meter: float = param(0.85)
    rate: float = param(5, unit="1/s", doc="Exponential follow rate for centre and distance.")
    centre: float = state(0.0)
    distance: float = state(7.225)

    def update(self, ctx, dt):
        a = ctx.world.placed(Placed.challenger).transform.position.x
        b = ctx.world.placed(Placed.rival).transform.position.x
        wanted = max(self.min_distance, (abs(a - b) + self.gap_padding) * self.distance_per_meter)
        blend = 1 - math.exp(-self.rate * dt)
        self.centre += ((a + b) / 2 - self.centre) * blend
        self.distance += (wanted - self.distance) * blend
        self.entity.transform.position = vec3(self.centre, self.height, -self.distance)
        self.entity.transform.look_at(vec3(self.centre, self.look_height, 0))
