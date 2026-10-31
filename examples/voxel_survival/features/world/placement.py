"""Where a block may go."""

from parallax import Context, ContentRef, Entity, TextRef
from parallax.characters import Character
from parallax.voxels import Cell3
from project import Content, Text

from game.config import Rules
from game.content import Block


def placement_problem(ctx: Context, block: ContentRef[Block], cell: Cell3, builder: Entity) -> TextRef | None:
    """Why `block` can't go in `cell`, or None if it can."""
    rules = ctx.config(Rules)
    above, below = cell + Cell3.UP, cell + Cell3.DOWN
    if not rules.build_min_y <= cell.y <= rules.build_max_y:
        return Text.no_room
    if not _free(ctx, cell) or blocks_body(builder, cell):
        return Text.no_room
    if block.data.upper and (not _free(ctx, above) or blocks_body(builder, above)):
        return Text.door_needs_room
    ground = ctx.voxels.get(below)
    if block.data.needs_soil and (ground is None or not ground.data.soil):
        return Text.plant_on_soil
    if block.data.needs_water_within and not _water_near(ctx, below, block.data.needs_water_within):
        return Text.crops_need_water
    return None


def blocks_body(entity: Entity, cell: Cell3) -> bool:
    """Would a solid block in `cell` overlap this character's body?"""
    body = entity.get(Character)
    p = entity.transform.position
    return (p.x - body.radius < cell.x + 1 and p.x + body.radius > cell.x
            and p.z - body.radius < cell.z + 1 and p.z + body.radius > cell.z
            and p.y < cell.y + 1 and p.y + body.height > cell.y)


def _free(ctx: Context, cell: Cell3) -> bool:
    current = ctx.voxels.get(cell)
    return current is None or current.data.replaceable


def _water_near(ctx: Context, cell: Cell3, reach: int) -> bool:
    span = range(-reach, reach + 1)
    return any(ctx.voxels.get(cell + Cell3(dx, 0, dz)) == Content.block.water for dx in span for dz in span)
