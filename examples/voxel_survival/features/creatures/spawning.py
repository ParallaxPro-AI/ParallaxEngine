"""Finding somewhere for a creature to stand."""

import math

from parallax import Context, ContentRef, Vec3, vec3
from parallax.voxels import Cell3

from features.world.feature import SafeZone
from game.content import Block


def ground_at(ctx: Context, around: Vec3, distance: float, heading: float) -> Vec3:
    """The surface `distance` metres from `around` in the `heading` direction (degrees)."""
    spot = around + Vec3.from_yaw_pitch(heading, length=distance)
    x, z = math.floor(spot.x), math.floor(spot.z)
    return vec3(x + 0.5, ctx.voxels.surface_height(spot), z + 0.5)


def ground_block(ctx: Context, point: Vec3) -> ContentRef[Block] | None:
    return ctx.voxels.get(ctx.voxels.cell_at(point) + Cell3.DOWN)


def is_safe(ctx: Context, point: Vec3) -> bool:
    """Inside a torch's or a held beacon's protection."""
    return any((e.transform.position - point).length() < zone.radius for e, zone in ctx.world.query(SafeZone))
