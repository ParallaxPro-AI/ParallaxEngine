import random

from parallax import Context, Entity, System, system
from parallax.grid import Grid, GridCell
from parallax.values import Cell
from project import Scenes

from game.actions import Controls
from game.board import board_grid, spawn_tile, tiles_by_cell, values
from game.components import Tile
from game.config import Rules
from game.events import GameEnded, MilestoneReached, Slid, TileSpawned, TilesFused
from game.resources import Outcome, Records, Score
from game.slide_logic import Merge, can_slide, slide

MOVES = ((Controls.up, Cell.UP), (Controls.down, Cell.DOWN),
         (Controls.left, Cell.LEFT), (Controls.right, Cell.RIGHT))


@system("slider", scenes=[Scenes.board])
class Slider(System):
    """Plays a slide on an arrow, swipe or d-pad press: moves every tile, fuses equal
    pairs, scores each fused tile's value, drops a new tile into a random empty cell,
    then checks for the target tile or a jammed board.

    The board's state changes at once and only the sprites take time to catch up,
    so a quick second swipe simply retargets the tiles mid-slide."""

    def update(self, ctx, dt):
        step = next((step for action, step in MOVES if ctx.input.pressed(action)), None)
        if step is not None:
            play_slide(ctx, step)


def play_slide(ctx: Context, step: Cell) -> None:
    grid = board_grid(ctx.world)
    tiles = tiles_by_cell(ctx.world)
    plan = slide(values(tiles), grid.cols, grid.rows, step)
    if not plan.changed:
        return

    seconds = ctx.config(Rules).slide_seconds
    landed: dict[Cell, Entity] = {}
    for move in plan.moves:
        tile = tiles[move.start]
        tile.transform.move_to(grid.center(move.end).xy(), seconds, ease="out_cubic")
        if move.absorbed:
            tile.remove(GridCell)
            tile.destroy(after=seconds)
        else:
            tile.get(GridCell).cell = move.end
            landed[move.end] = tile
    for merge in plan.merges:
        fuse(ctx, grid, landed[merge.cell], merge)
    ctx.emit(Slid(fused=bool(plan.merges)))
    if plan.merges:
        ctx.get(Score).scored_slides += 1
    record_highest(ctx, max((merge.value for merge in plan.merges), default=0))

    cell = random.choice([cell for cell in grid.cells() if cell not in landed])
    landed[cell] = spawn_tile(ctx, grid, cell)
    score = ctx.get(Score)
    score.highest = max(score.highest, landed[cell].get(Tile).value)
    ctx.emit(TileSpawned(at=grid.center(cell)))

    if ctx.get(Score).highest >= ctx.config(Rules).target:
        end_game(ctx, Outcome.WON)
    elif not can_slide(values(landed), grid.cols, grid.rows):
        end_game(ctx, Outcome.LOST)


def fuse(ctx: Context, grid: Grid, tile: Entity, merge: Merge) -> None:
    tile.get(Tile).value = merge.value
    score = ctx.get(Score)
    score.points += merge.value
    records = ctx.get(Records)
    records.best_score = max(records.best_score, score.points)
    ctx.emit(TilesFused(at=grid.center(merge.cell), value=merge.value))


def record_highest(ctx: Context, top: int) -> None:
    """The biggest tile this slide forged: a new highest rings once (at most once per
    slide, however many pairs fused) and counts toward the best tile."""
    score = ctx.get(Score)
    if top <= score.highest:
        return
    score.highest = top
    records = ctx.get(Records)
    records.best_tile = max(records.best_tile, top)
    if top >= ctx.config(Rules).milestone:
        ctx.emit(MilestoneReached(value=top))


def end_game(ctx: Context, outcome: Outcome) -> None:
    """Settle the game; the result panel follows `Score.outcome` by itself."""
    ctx.get(Score).outcome = outcome
    ctx.emit(GameEnded(won=outcome is Outcome.WON))
