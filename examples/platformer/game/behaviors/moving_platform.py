"""Oscillates a platform along one axis."""

import math
from typing import Literal

from parallax import Behavior, Vec3, behavior, param, state, vec3


@behavior("moving_platform")
class MovingPlatform(Behavior):
    """Slides along `axis` (or rises and falls, never below where it was
    placed). Platforms are desynchronised by position so a cluster doesn't move
    in lockstep. It's a kinematic body, so riders are carried."""

    axis: Literal["x", "y", "z"] = param("x")
    range: float = param(3.5, unit="m")
    speed: float = param(1.6, doc="rad/s")

    origin: Vec3 = state(Vec3.ZERO)
    phase: float = state(0.0)

    def start(self, ctx):
        self.origin = self.entity.transform.position
        self.phase = self.origin.x * 0.37 + self.origin.z * 0.23

    def update(self, ctx, dt):
        self.phase += self.speed * dt
        if self.axis == "y":
            offset = vec3(0, (1 - math.cos(self.phase)) * 0.5 * self.range, 0)
        else:
            offset = (Vec3.RIGHT if self.axis == "x" else Vec3.FORWARD) * math.sin(self.phase) * self.range
        self.entity.transform.position = self.origin + offset
