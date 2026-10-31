from parallax import Context, PrefabRef, System, system
from parallax.grid import Grid, GridCell
from parallax.values import Cell
from project import Prefabs, Scenes

from game.level import current_level, yard_grid
from game.resources import Attempt, Records, Shift
from game.sokoban import parse


@system("builder", scenes=[Scenes.yard])
class Builder(System):
    """Builds the current level from its ASCII rows each time the yard scene loads:
    floor and walls on every cell, the dock pads, the crates and the bot. It sizes the
    yard's grid to the level (the camera keeps a fixed 12 x 12 m view around it), makes
    this level the shift's resume point, and lets the HUD's level card sweep in when the
    level is new (not after a reset)."""

    def start(self, ctx):
        plan = parse(current_level(ctx).rows)
        grid = yard_grid(ctx.world)
        grid.cols, grid.rows = plan.cols, plan.rows
        for cell in grid.cells():
            place(ctx, grid, Prefabs.wall if cell in plan.walls else Prefabs.floor, cell)
        for cell in plan.pads:
            place(ctx, grid, Prefabs.pad, cell)
        for cell in plan.crates:
            place(ctx, grid, Prefabs.crate, cell)
        place(ctx, grid, Prefabs.bot, plan.bot)

        shift = ctx.get(Shift)
        ctx.get(Attempt).intro = shift.introduced != shift.level_index
        shift.introduced = shift.level_index
        ctx.get(Records).resume_level = shift.level_index


def place(ctx: Context, grid: Grid, prefab: PrefabRef, cell: Cell) -> None:
    ctx.world.spawn(prefab, at=grid.center(cell).xy(), components=[GridCell(cell=cell)])
