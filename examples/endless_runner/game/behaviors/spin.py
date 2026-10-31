"""Spins an entity about its vertical axis."""

from parallax import Behavior, behavior, param


@behavior("spin")
class Spin(Behavior):
    """Turns the entity at a steady rate, so coins and power-ups catch the eye."""

    speed: float = param(180, unit="deg/s")

    def update(self, ctx, dt):
        transform = self.entity.transform
        transform.euler = transform.euler.with_y(transform.euler.y + self.speed * dt)
