"""Shooting, shared by the player and the bots: one ray, one hit, the same rules."""

import math
import random

from parallax import Color, Context, Entity, Vec3, deg, heading_to
from parallax.combat import Health
from project import Assets

from game.components import SmokeCloud
from game.events import ShotFired
from game.layers import Layers


def scatter(direction: Vec3, degrees: float) -> Vec3:
    """The direction knocked off by up to `degrees` in a random way."""
    if degrees <= 0:
        return direction
    yaw = heading_to(Vec3.ZERO, direction) + random.uniform(-degrees, degrees)
    pitch = deg(math.asin(direction.y)) + random.uniform(-degrees, degrees)
    return Vec3.from_yaw_pitch(yaw, pitch)


def fire_bullet(ctx: Context, shooter: Entity, origin: Vec3, direction: Vec3, *,
                damage: float, range: float, tracer: Color) -> None:
    """Trace one bullet. Walls and crates stop it; a fighter on the other side takes
    `damage` (the combat pipeline applies upgrades and plating)."""
    hit = ctx.physics.raycast(origin, direction, range, layers=[Layers.world, Layers.body], ignore=[shooter])
    end = hit.point if hit else origin + direction * range
    ctx.vfx.beam(origin, end, color=tracer)
    if hit:
        ctx.vfx.play(Assets.vfx.bullet_impact, at=end, color=tracer)
    victim = None
    if hit and hit.entity is not None and hit.entity.has(Health) and ctx.combat.are_enemies(shooter, hit.entity):
        hit.entity.get(Health).damage(damage, source=shooter, point=hit.point)
        victim = hit.entity
    ctx.emit(ShotFired(shooter=shooter, hit=victim))


def smoke_between(ctx: Context, a: Vec3, b: Vec3) -> bool:
    """A smoke cloud blocks the line from `a` to `b` (also when either end is inside it)."""
    span = b - a
    length = span.length() or 1
    for cloud, smoke in ctx.world.query(SmokeCloud):
        center = cloud.transform.position + Vec3(0, 1.4, 0)
        t = max(0.0, min(1.0, (center - a).dot(span) / (length * length)))
        if (a + span * t).distance_to(center) < smoke.radius:
            return True
    return False
