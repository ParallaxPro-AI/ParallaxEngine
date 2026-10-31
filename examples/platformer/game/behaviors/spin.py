"""Spins and bobs a pickup."""

import math

from parallax import Behavior, Vec3, behavior, param, state, vec3


@behavior("spin")
class Spin(Behavior):
    """Turns the entity and bobs it gently, so pickups catch the eye."""

    speed: float = param(120, unit="deg/s")
    bob: float = param(0.15, unit="m")
    bob_rate: float = param(2.5, doc="rad/s")

    origin: Vec3 = state(Vec3.ZERO)

    def start(self, ctx):
        self.origin = self.entity.transform.position

    def update(self, ctx, dt):
        transform = self.entity.transform
        transform.euler = transform.euler.with_y(transform.euler.y + self.speed * dt)
        transform.position = self.origin + vec3(0, math.sin(ctx.time.now * self.bob_rate) * self.bob, 0)
