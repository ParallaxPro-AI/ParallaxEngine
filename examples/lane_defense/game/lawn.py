"""Board questions shared by systems and behaviors.

The lawn is a `Grid` on the xz plane centered on the lawn model
(prefabs/lawn_grid.prefab.json): columns run along x (husks walk toward -x), rows
run along z (the five lanes). Rows read like the template's: row 0 is the far (top)
row and row 4 the one nearest the camera (`row_order="down"`).
"""

from parallax import Context, vec3
from parallax.grid import Cell, Grid

from game.content import LaneRule, LevelDef, WaveDef
from game.resources import Campaign, Planting, Tool

PLANT_Y = 0.08
# Plants and husks spawn turned 180° (the template's spawn turn): faces toward the camera and down the lane.
SPAWN_TURN = vec3(0, 180, 0)
"""Plants stand a little above the lawn, as the template placed them."""


def lawn(ctx: Context) -> Grid:
    _, grid = ctx.world.query(Grid).single()
    return grid


def lane_z(ctx: Context, row: int) -> float:
    return lawn(ctx).center(Cell(0, row)).z


def current_level(ctx: Context) -> LevelDef:
    return ctx.get(Campaign).level.data


def husk_count(level: LevelDef, wave: WaveDef) -> int:
    """How many husks a wave sends: one per entry, or one per open lane for ALL waves."""
    return len(wave.husks) * (len(level.lanes) if wave.lanes is LaneRule.ALL else 1)


def tool_fits(ctx: Context, cell: Cell) -> bool:
    """Would the armed tool do something in this cell? (Drives the highlight color.)"""
    tool = ctx.get(Planting).tool
    if cell.row not in current_level(ctx).lanes:
        return False
    if tool is Tool.WATER:
        return True
    occupied = lawn(ctx).first_at(cell) is not None
    return occupied if tool is Tool.DIG else not occupied
