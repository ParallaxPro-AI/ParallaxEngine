from parallax.grid import Grid
from parallax.test import GameHarness, playtest
from parallax.values import Cell
from project import Placed, Scenes

from game.components import Piece
from game.events import MarkPlaced
from game.resources import Match, Record
from game.rules import Mark, mark_at
from game.ui import GameOver, Hud, TitleScreen

CENTRE = Cell(1, 1)
CORNERS_FIRST = [Cell(0, 0), Cell(2, 0), Cell(0, 2), Cell(2, 2), Cell(1, 0), Cell(0, 1), Cell(2, 1), Cell(1, 2), CENTRE]


async def tap_cell(h: GameHarness, cell: Cell) -> None:
    """Tap a cell; advances exactly one frame."""
    await h.tap_world(h.world.placed(Placed.board).get(Grid).center(cell))


async def play(h: GameHarness, cell: Cell) -> None:
    """Tap a free cell as the Sun, then wait out the Moon's reply unless the
    Sun's mark ended the game."""
    await tap_cell(h, cell)
    if h.get(Match).result is None:
        reply = await h.until(MarkPlaced)
        assert reply.mark is Mark.MOON


@playtest("taking the centre gets a reply from the Moon")
async def test_moon_replies(h: GameHarness):
    await h.start(scene=Scenes.board)
    await play(h, CENTRE)
    assert mark_at(h.get(Match).cells, CENTRE) is Mark.SUN
    assert h.world.query(tagged=Piece).count() == 2


@playtest("a tap on a taken cell does not spend the turn")
async def test_taken_cell(h: GameHarness):
    await h.start(scene=Scenes.board)
    await play(h, CENTRE)
    await tap_cell(h, CENTRE)
    assert h.get(Match).cells.count(Mark.SUN) == 1


@playtest("the perfect Moon cannot be beaten")
async def test_moon_never_loses(h: GameHarness):
    await h.start(scene=Scenes.board)
    for cell in CORNERS_FIRST:  # the strongest try
        match = h.get(Match)
        if match.result is not None:
            break
        if mark_at(match.cells, cell) is None:
            await play(h, cell)
    await h.advance_until(lambda: h.is_open(GameOver))
    assert h.get(Record).wins == 0


@playtest("the title shows the empty board, and Play starts a game on your move")
async def test_title_to_board(h: GameHarness):
    await h.start(scene=Scenes.title)
    assert h.is_open(TitleScreen)
    await h.click(TitleScreen, "start")
    await h.advance(frames=2)
    assert h.ctx.scenes.current_is(Scenes.board)
    hud = h.panel_state(Hud)
    assert hud["yours"] and hud["banner"]
    await h.advance(seconds=2.1)
    assert not h.panel_state(Hud)["banner"]


@playtest("a finished game is banked in the record, and Play again starts a fresh board")
async def test_record_and_play_again(h: GameHarness):
    await h.start(scene=Scenes.board)
    for cell in CORNERS_FIRST:
        match = h.get(Match)
        if match.result is not None:
            break
        if mark_at(match.cells, cell) is None:
            await play(h, cell)
    await h.advance_until(lambda: h.is_open(GameOver))
    record = h.get(Record)
    assert record.losses + record.draws == 1

    await h.click(GameOver, "play_again")
    await h.advance(frames=2)
    assert h.get(Match).result is None
    assert h.world.query(tagged=Piece).count() == 0
    assert h.get(Record).losses + h.get(Record).draws == 1
