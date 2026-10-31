"""A blade swinging on a chain from a pivot above it."""

import math

from typing import Literal

from parallax import Behavior, Vec3, behavior, deg, param, rad, state, vec3


@behavior("swinging_blade")
class SwingingBlade(Behavior):
    """Swings on an arc from a pivot `length` above where it was placed.
    Time your run under it as it swings away. `axis` is the way it swings: "z"
    (towards and away from the camera, the template's) or "x" (along the run)."""

    axis: Literal["x", "z"] = param("z")

    length: float = param(4, unit="m")
    amplitude: float = param(63, unit="deg")
    speed: float = param(1.8, doc="rad/s")

    pivot: Vec3 = state(Vec3.ZERO)
    phase: float = state(0.0)

    def start(self, ctx):
        self.pivot = self.entity.transform.position + vec3(0, self.length, 0)
        self.phase = self.pivot.x * 0.23 + self.pivot.z * 0.31

    def update(self, ctx, dt):
        self.phase += self.speed * dt
        angle = math.sin(self.phase) * rad(self.amplitude)
        swing, drop = math.sin(angle) * self.length, -math.cos(angle) * self.length
        if self.axis == "x":
            self.entity.transform.position = self.pivot + vec3(swing, drop, 0)
            self.entity.transform.euler = vec3(0, 0, deg(angle))
        else:
            self.entity.transform.position = self.pivot + vec3(0, drop, swing)
