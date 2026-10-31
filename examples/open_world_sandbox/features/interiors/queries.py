"""Which interior contains a point."""

from parallax import Context, Entity, Vec3

from features.interiors.components import InteriorZone

SEARCH_RADIUS = 40
"""No interior zone is larger than this, so nearer zones are the only candidates."""


def interior_at(ctx: Context, point: Vec3) -> Entity | None:
    for zone, box in ctx.world.query(InteriorZone).near(point, SEARCH_RADIUS):
        offset = point - zone.transform.position
        if abs(offset.x) <= box.size.x / 2 and 0 <= offset.y <= box.size.y and abs(offset.z) <= box.size.z / 2:
            return zone
    return None
