from parallax import Vec3
from parallax.grid import Grid
from parallax.test import GameHarness, playtest
from parallax.values import Cell
from project import Placed, Scenes

from game.components import Piece
from game.config import Rules
from game.events import DiscDropped, MatchEnded
from game.resources import Match, Record, Result
from game.ui import GameOver
from game.well import EMPTY_WELL, Disc, disc_at, drop


def over_column(h: GameHarness, col: int) -> Vec3:
    """A world point over the well, high up in a column."""
    return h.world.placed(Placed.well).get(Grid).center(Cell(col, 4))


@playtest("the player's disc falls to the bottom and teal answers after its beat")
async def test_drop_and_reply(h: GameHarness):
    await h.start(scene=Scenes.well)
    await h.tap_world(over_column(h, 3))
    assert disc_at(h.get(Match).cells, Cell(3, 0)) is Disc.AMBER

    tapped_at = h.ctx.time.now
    reply = await h.until(DiscDropped)
    assert reply.disc is Disc.TEAL
    assert h.ctx.time.now - tapped_at >= h.ctx.config(Rules).think_seconds
    assert h.world.query(tagged=Piece).count() == 2


@playtest("a tap below the well drops nothing")
async def test_tap_outside_well(h: GameHarness):
    await h.start(scene=Scenes.well)
    await h.tap_world(over_column(h, 3).with_y(h.ctx.config(Rules).aim_bottom - 0.5))
    assert Disc.AMBER not in h.get(Match).cells


@playtest("four amber in a row wins, rings the line and extends the streak")
async def test_connect_four(h: GameHarness):
    await h.start(scene=Scenes.well)
    cells = h.get(Match).cells
    for col in range(3):
        cells, _ = drop(cells, col, Disc.AMBER)
        cells, _ = drop(cells, col, Disc.TEAL)
    h.get(Match).cells = cells

    await h.tap_world(over_column(h, 3))
    assert [ended.result for ended in h.emitted(MatchEnded)] == [Result.WIN]
    assert h.get(Match).winning_line == [Cell(col, 0) for col in range(4)]
    assert not h.is_open(GameOver)

    await h.advance_until(lambda: h.is_open(GameOver))
    assert h.get(Record).streak == 1


@playtest("teal completes its four: a loss resets the streak, and Play again clears the well")
async def test_loss_and_play_again(h: GameHarness):
    await h.start(scene=Scenes.well)
    h.get(Record).streak = 2
    cells = h.get(Match).cells
    for amber, teal in ((6, 0), (5, 1), (6, 2)):
        cells, _ = drop(cells, amber, Disc.AMBER)
        cells, _ = drop(cells, teal, Disc.TEAL)
    h.get(Match).cells = cells

    await h.tap_world(over_column(h, 4))
    ended = await h.until(MatchEnded)
    assert ended.result is Result.LOSS
    assert h.get(Match).winning_line == [Cell(col, 0) for col in range(4)]
    record = h.get(Record)
    assert (record.losses, record.streak) == (1, 0)

    await h.advance_until(lambda: h.is_open(GameOver))
    await h.click(GameOver, "play_again")
    await h.advance_until(lambda: not h.is_open(GameOver))
    assert h.get(Match).cells == EMPTY_WELL
    assert h.get(Match).result is None
    assert h.world.query(tagged=Piece).count() == 0
