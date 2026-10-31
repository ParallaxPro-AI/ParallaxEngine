"""Walks back and forth."""

from parallax import Behavior, behavior, param, state


@behavior("patrol")
class Patrol(Behavior):
    """Walks `range` metres either side of where it was placed, turning at each end."""

    speed: float = param(2, unit="m/s")
    range: float = param(1.5, unit="m")

    origin_x: float = state(0.0)
    direction: int = state(1)

    def start(self, ctx):
        self.origin_x = self.entity.transform.position.x

    def update(self, ctx, dt):
        transform = self.entity.transform
        x = transform.position.x + self.direction * self.speed * dt
        if abs(x - self.origin_x) > self.range:
            self.direction = -self.direction
        transform.position = transform.position.with_x(x)
        transform.euler = transform.euler.with_y(90 * self.direction)
