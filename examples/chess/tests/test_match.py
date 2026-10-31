from parallax.grid import Grid
from parallax.test import GameHarness, playtest
from project import Content, Placed, Scenes

from game.board import position
from game.chess.position import BLACK, WHITE, Position, cell_of, parse_square
from game.components import Piece
from game.config import Rules
from game.systems.board_view import spawn_piece
from game.chess.status import Ending
from game.events import MatchEnded, MoveMade
from game.resources import Match, Record, Session
from game.ui import GameOver, Hud, PromotionPicker, TitleScreen


async def tap_square(h: GameHarness, name: str) -> None:
    """Tap a square by name; advances exactly one frame."""
    board = h.world.placed(Placed.board).get(Grid)
    await h.tap_world(board.center(cell_of(parse_square(name))))


@playtest("the board is set out with all 32 pieces")
async def test_set_out(h: GameHarness):
    await h.start(scene=Scenes.board)
    assert h.world.query(tagged=Piece).count() == 32
    assert position(h.ctx).turn == WHITE


@playtest("the computer answers the player's first move after its thinking beat")
async def test_computer_replies(h: GameHarness):
    await h.start(scene=Scenes.board)
    await tap_square(h, "e2")
    await tap_square(h, "e4")
    assert h.get(Match).moves == ["e4"]

    started = h.ctx.time.now
    reply = await h.until(MoveMade)
    assert position(h.ctx).turn == WHITE
    assert Position.from_fen(reply.before).turn == BLACK
    assert h.ctx.time.now - started >= h.ctx.config(Rules).think_seconds
    assert h.world.query(tagged=Piece).count() == 32


@playtest("tapping an illegal square keeps the piece where it is")
async def test_illegal_move(h: GameHarness):
    await h.start(scene=Scenes.board)
    await tap_square(h, "e2")
    await tap_square(h, "e5")
    assert h.get(Match).moves == []


@playtest("resigning ends the match as a loss, and the card waits a beat")
async def test_resign(h: GameHarness):
    await h.start(scene=Scenes.board)
    await h.click(Hud, "resign")
    await h.advance_until(lambda: bool(h.emitted(MatchEnded)))
    assert not h.is_open(GameOver)
    await h.advance_until(lambda: h.is_open(GameOver))
    assert h.get(Record).losses == 1


@playtest("the chosen opponent survives Play again")
async def test_difficulty_survives_retry(h: GameHarness):
    await h.start(scene=Scenes.title)
    await h.click(TitleScreen, "choose", difficulty="hard")
    await h.advance_until(lambda: h.is_open(Hud))
    await h.click(Hud, "resign")
    await h.advance_until(lambda: h.is_open(GameOver))
    await h.click(GameOver, "play_again")
    await h.advance_until(lambda: not h.is_open(GameOver))
    assert h.get(Session).difficulty == Content.difficulty.hard
    assert h.get(Match).moves == []


async def start_from(h: GameHarness, fen: str) -> None:
    """Open the board, then set up a position: the match and the piece sprites both."""
    await h.start(scene=Scenes.board)
    match = h.get(Match)
    match.fen = fen
    match.history = [Position.from_fen(fen).key()]
    for piece in h.world.query(tagged=Piece):
        piece.destroy()
    for square, piece in enumerate(Position.from_fen(fen).board):
        if piece:
            spawn_piece(h.ctx, piece, square)
    await h.advance(frames=1)


@playtest("a back-rank mate wins: the card says Victory and the record counts it")
async def test_checkmate_wins(h: GameHarness):
    await start_from(h, "6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1")
    await tap_square(h, "d1")
    await tap_square(h, "d8")
    assert h.get(Match).moves == ["Qd8#"]
    assert [(ended.ending, ended.winner) for ended in h.emitted(MatchEnded)] == [(Ending.CHECKMATE, WHITE)]
    await h.advance_until(lambda: h.is_open(GameOver))
    assert h.panel_state(GameOver)["title"] == "Victory"
    assert h.get(Record).wins == 1


@playtest("a pawn reaching the last rank waits for the picker, which promotes it")
async def test_promotion_picker(h: GameHarness):
    await start_from(h, "r7/4P3/8/8/8/8/8/k6K w - - 0 1")
    await tap_square(h, "e7")
    await tap_square(h, "e8")
    assert h.is_open(PromotionPicker)
    assert h.get(Match).moves == []

    await h.click(PromotionPicker, "choose", piece="n")
    await h.advance(frames=1)
    assert not h.is_open(PromotionPicker)
    assert h.get(Match).moves == ["e8=N"]
    assert position(h.ctx).board[parse_square("e8")] == "N"
