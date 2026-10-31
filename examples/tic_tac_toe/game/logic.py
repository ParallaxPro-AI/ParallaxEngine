"""Every system of the game. Small enough for one module: the board is a
resource, the rules are in `game/rules.py`, and each system below does one job.
Title, pause and the result card need no system at all (see `game/ui.py`)."""

import random

from parallax import System, Vec2, Vec3, on, system
from parallax.grid import Grid
from parallax.values import Cell
from project import Assets, Placed, Prefabs, Scenes

from game.audio import Sounds, play
from game.config import Rules
from game.events import CellChosen, MarkPlaced, MatchEnded
from game.resources import Match, Record, Result
from game.rules import Mark, best_cells, empty_cells, is_full, mark_at, place, turn, winning_line

PIECE_PREFABS = {Mark.SUN: Prefabs.mark_sun, Mark.MOON: Prefabs.mark_moon}


def board(ctx) -> Grid:
    return ctx.world.placed(Placed.board).get(Grid)


def spot(ctx, cell: Cell) -> Vec2:
    """Where a cell is drawn. A 2D point, so spawns take each prefab's `"z"`."""
    return board(ctx).center(cell).xy()


def in_play(ctx) -> bool:
    return ctx.get(Match).result is None


def sun_to_move(ctx) -> bool:
    return in_play(ctx) and turn(ctx.get(Match).cells) is Mark.SUN


@system("player_marks", scenes=[Scenes.board], when=sun_to_move)
class PlayerMarks(System):
    """Turns a tap on an empty cell into the player's Sun. A tap on a taken cell
    or off the board only clicks; it doesn't spend the turn."""

    def update(self, ctx, dt):
        pointer = ctx.input.pointer
        if not pointer.pressed:
            return
        cell = board(ctx).cell_at(pointer.world)
        if cell is not None and mark_at(ctx.get(Match).cells, cell) is None:
            ctx.emit(CellChosen(cell=cell, mark=Mark.SUN))
        else:
            play(ctx, ctx.config(Sounds).taken)


@system("referee", scenes=[Scenes.board])
class Referee(System):
    """Owns the board: places every legal mark while the game is in play and
    calls a line or a full board. The result is settled before `MarkPlaced`
    goes out, so the Moon never answers a finishing mark."""

    @on(CellChosen, when=in_play)
    def place_mark(self, ctx, event: CellChosen):
        match = ctx.get(Match)
        if event.mark is not turn(match.cells) or mark_at(match.cells, event.cell) is not None:
            return
        match.cells = place(match.cells, event.cell, event.mark)
        if winning_line(match.cells):
            match.result = Result.WIN if event.mark is Mark.SUN else Result.LOSS
        elif is_full(match.cells):
            match.result = Result.DRAW

        ctx.emit(MarkPlaced(cell=event.cell, mark=event.mark))
        if match.result is not None:
            ctx.emit(MatchEnded(result=match.result))


@system("opponent", scenes=[Scenes.board])
class Opponent(System):
    """Plays the Moon: a perfect minimax player with random tie-breaks, who slips
    `mistake_chance` of the time."""

    @on(MarkPlaced, when=in_play, where=lambda event: event.mark is Mark.SUN)
    def reply(self, ctx, event: MarkPlaced):
        ctx.run(moon_move)


async def moon_move(ctx, task):
    """A thinking beat (frozen by the pause menu), then the Moon's cell."""
    rules = ctx.config(Rules)
    await task.seconds(rules.think_seconds)
    cells = ctx.get(Match).cells
    slip = random.random() < rules.mistake_chance
    cell = random.choice(empty_cells(cells) if slip else best_cells(cells, Mark.MOON))
    ctx.emit(CellChosen(cell=cell, mark=Mark.MOON))


@system("board_view", scenes=[Scenes.board, Scenes.title])
class BoardView(System):
    """Draws the board from its `Grid` (the empty board also sits behind the title),
    pops in each placed mark with a burst, and rings the winning line."""

    def start(self, ctx):
        for cell in board(ctx).cells():
            ctx.world.spawn(Prefabs.cell, at=spot(ctx, cell))

    @on(MarkPlaced)
    def show_mark(self, ctx, event: MarkPlaced):
        at = spot(ctx, event.cell)
        piece = ctx.world.spawn(PIECE_PREFABS[event.mark], at=at)
        piece.transform.scale = Vec3.ZERO
        piece.transform.scale_to(1.0, 0.18)
        ctx.vfx.play(Assets.vfx.place_burst, at=at)
        play(ctx, ctx.config(Sounds).place)

    @on(MatchEnded)
    def show_line(self, ctx, event: MatchEnded):
        line = winning_line(ctx.get(Match).cells)
        if line:
            for cell in line:
                ctx.world.spawn(Prefabs.win_marker, at=spot(ctx, cell))
            ctx.camera.main.shake(0.12, 0.2)


@system("results", scenes=[Scenes.board])
class Results(System):
    """Banks each finished game in the lifetime record. The result card opens by
    itself (`GameOver`'s `when=`)."""

    @on(MatchEnded)
    def conclude(self, ctx, event: MatchEnded):
        record = ctx.get(Record)
        if event.result is Result.WIN:
            record.wins += 1
            record.streak += 1
            record.best_streak = max(record.best_streak, record.streak)
            play(ctx, ctx.config(Sounds).win)
        elif event.result is Result.LOSS:
            record.losses += 1
            record.streak = 0
            play(ctx, ctx.config(Sounds).lose)
        else:
            record.draws += 1
            play(ctx, ctx.config(Sounds).draw)
