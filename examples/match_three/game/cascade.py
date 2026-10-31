"""The animated resolution of one swap, as a task (`resolve_swap`) that reads top to
bottom in the order the player sees it: the slide, then wave after wave of clears,
falls and refills until nothing matches, then a reshuffle if the board is dead.

The `Play` system starts it and keeps its handle in `BoardState.resolving`, so "is a
swap resolving?" is `handle.active`, not a flag."""

import random

from parallax import Context, Entity, Handle, Task
from parallax.grid import Grid, GridCell
from parallax.values import Cell

from game.board import board_grid, board_of, gems_by_cell, spawn_gem, specials_of
from game.components import Crust, Gem
from game.config import Rules
from game.descent import mods
from game.events import BoardSettled, GemShattered, SwapMade, SwapRejected, WaveCleared
from game.match_logic import find_swap, has_match, plan_wave, reshuffle
from game.resources import BoardState, Run


async def resolve_swap(ctx: Context, task: Task, a: Cell, b: Cell) -> None:
    grid = board_grid(ctx.world)
    gems = gems_by_cell(ctx.world)
    await slide_pair(ctx, task, grid, gems, a, b)
    if has_match(board_of(grid, gems)):
        ctx.emit(SwapMade(a=a, b=b))
        await cascade(ctx, task, grid, focus=b)
        keep_playable(ctx, grid)
    else:
        await slide_pair(ctx, task, grid, gems, a, b)
        ctx.emit(SwapRejected())
    ctx.emit(BoardSettled())


async def slide_pair(ctx: Context, task: Task, grid: Grid, gems: dict[Cell, Entity],
                     a: Cell, b: Cell) -> None:
    """Swap two gems, on the board and on screen."""
    first, second = gems[a], gems[b]
    first.get(GridCell).cell, second.get(GridCell).cell = b, a
    gems[a], gems[b] = second, first
    seconds = ctx.config(Rules).glide_seconds
    await task.all(glide(grid, first, b, seconds), glide(grid, second, a, seconds))


async def cascade(ctx: Context, task: Task, grid: Grid, focus: Cell | None) -> None:
    rules = ctx.config(Rules)
    state = ctx.get(BoardState)
    bonus = mods(ctx.get(Run))
    while True:
        gems = gems_by_cell(ctx.world)
        wave = plan_wave(board_of(grid, gems), specials_of(gems), focus,
                         rules.bomb_radius + bonus.bomb_radius_bonus)
        if not wave.clears:
            break
        state.chain += 1
        chipped = chip_crust(ctx, grid, wave.clears, bonus.thaw)
        cleared = [shatter(ctx, gems.pop(cell)) for cell in wave.clears]
        for cell, special in wave.forged.items():
            gems[cell].get(Gem).special = special
        ctx.emit(WaveCleared(chain=state.chain, gems=len(wave.clears), crust=chipped,
                             forged=len(wave.forged), detonated=wave.detonated))
        await task.seconds(rules.clear_seconds)
        for gem in cleared:
            gem.destroy()
        await task.all(*drop_and_refill(ctx, grid, gems))
        focus = None
    state.chain = 0


def glide(grid: Grid, gem: Entity, cell: Cell, seconds: float) -> Handle:
    """Ease a gem into a cell's centre, fast at first and settling softly (the template
    eased every gem toward its cell each frame). `.xy()` keeps the gem at its own depth:
    the grid's centres sit at the board's z."""
    return gem.transform.move_to(grid.center(cell).xy(), seconds, ease="out_cubic")


def shatter(ctx: Context, gem: Entity) -> Entity:
    """Burst a cleared gem. It leaves the board at once (its `GridCell` goes) but stays
    on screen under its burst until the caller destroys it."""
    ctx.emit(GemShattered(at=gem.transform.position, kind=gem.get(Gem).kind))
    gem.remove(GridCell)
    return gem


def chip_crust(ctx: Context, grid: Grid, cleared: frozenset[Cell], thaw: bool) -> int:
    """Chip one layer off every crusted cell that was cleared (and, with the thaw
    relic, every crusted cell beside one). Returns how many layers came off."""
    hit = set(cleared)
    if thaw:
        hit |= {near for cell in cleared for near in grid.neighbors(cell)}
    chipped = 0
    for entity, crust, place in ctx.world.query(Crust, GridCell):
        if place.cell in hit:
            crust.layers -= 1
            chipped += 1
            if crust.layers == 0:
                entity.destroy()
    return chipped


def drop_and_refill(ctx: Context, grid: Grid, gems: dict[Cell, Entity]) -> list[Handle]:
    """Let every gem fall as far as it can, and drop new gems in from above the
    board into the gaps left at the top of each column."""
    kinds = ctx.get(BoardState).kinds
    seconds = ctx.config(Rules).glide_seconds
    falls = []
    for col in range(grid.cols):
        landing = grid.rows - 1
        for row in reversed(range(grid.rows)):
            gem = gems.get(Cell(col, row))
            if gem is None:
                continue
            if row != landing:
                gem.get(GridCell).cell = Cell(col, landing)
                falls.append(glide(grid, gem, Cell(col, landing), seconds))
            landing -= 1
        gap = landing + 1
        for row in range(gap):
            gem = spawn_gem(ctx, grid, random.choice(kinds), Cell(col, row), drop=gap)
            falls.append(glide(grid, gem, Cell(col, row), seconds))
    return falls


def keep_playable(ctx: Context, grid: Grid) -> None:
    """If no swap can make a match any more, deal the same gems again as a shuffled,
    playable board, in place."""
    gems = gems_by_cell(ctx.world)
    board = board_of(grid, gems)
    if find_swap(board) is not None:
        return
    for old, new in reshuffle(board).items():
        gems[old].get(GridCell).cell = new
        gems[old].transform.position = grid.center(new)
