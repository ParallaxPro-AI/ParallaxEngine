"""Room geometry: where a cell sits in the world, which room a point is in, and a fight
room's cover layout with the open spots where enemies and breakables can stand."""

import random

from parallax import Context, Entity, Vec3, vec3
from parallax.values import Cell

from game.components import Room
from game.cover_layout import TileSpec, pinned_open, reachable_open, solve
from game.rules import Rules


def room_center(rules: Rules, cell: Cell) -> Vec3:
    return vec3(cell.col * rules.room_size, 0, cell.row * rules.room_size)


def room_at(ctx: Context, point: Vec3, margin: float = 0) -> tuple[Entity, Room] | None:
    """The room containing `point`, at least `margin` metres from its walls."""
    reach = ctx.config(Rules).room_size / 2 - margin
    for entity, room in ctx.world.query(Room):
        offset = point - entity.transform.position
        if abs(offset.x) <= reach and abs(offset.z) <= reach:
            return entity, room
    return None


def lay_cover(ctx: Context, rules: Rules, center: Vec3, avoid: Vec3, need: int) -> list[Vec3]:
    """Solve and spawn a fight room's cover (game/cover_layout.py), then return `need`
    shuffled open spots the keeper can reach, none in the centre block or near `avoid`
    (inner cells first; spots repeat when there are too few)."""
    size = rules.cover_size
    step = rules.cover_cell
    tiles = [TileSpec(id=tile.id, weight=tile.weight, edges={"n": tile.n, "e": tile.e, "s": tile.s, "w": tile.w})
             for tile in rules.cover_tiles]
    open_tile = [i for i, tile in enumerate(rules.cover_tiles) if tile.prefab is None][0]
    pins = {cell: open_tile for cell in pinned_open(size, rules.cover_centre)}
    grid = solve(tiles, size, pins, rules.cover_restarts) or {}
    origin = center - vec3(1, 0, 1) * ((size - 1) * step / 2)
    cover = {}
    for row in range(size):
        for col in range(size):
            cell = Cell(col, row)
            prefab = rules.cover_tiles[grid.get(cell, open_tile)].prefab
            cover[cell] = prefab is not None
            if prefab is not None:
                ctx.world.spawn(prefab, at=origin + vec3(col, 0, row) * step)
    inner = []
    ring = []
    for cell in reachable_open(cover, size):
        spot = origin + vec3(cell.col, 0, cell.row) * step
        if spot.distance_to(avoid) <= rules.spawn_clearance or spot.distance_to(center) < step:
            continue
        if cell.col in (0, size - 1) or cell.row in (0, size - 1):
            ring.append(spot)
        else:
            inner.append(spot)
    random.shuffle(inner)
    random.shuffle(ring)
    spots = inner + ring if len(inner) < need else inner
    if not spots:
        return [center for _ in range(need)]
    return [spots[i % len(spots)] for i in range(need)]
