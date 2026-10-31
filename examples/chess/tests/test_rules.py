"""Unit tests for the pure rules package. No engine, no harness: positions in,
moves out."""

from parallax.values import Cell

from game.chess.moves import find_move, legal_moves, play
from game.chess.notation import san
from game.chess.position import Position, cell_of, parse_square, square_at
from game.chess.status import Ending, ending_of, insufficient_material

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
KIWIPETE = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"


def perft(position: Position, depth: int) -> int:
    if depth == 0:
        return 1
    return sum(perft(play(position, move), depth - 1) for move in legal_moves(position))


def play_line(fen: str, line: str) -> Position:
    position = Position.from_fen(fen)
    for uci in line.split():
        position = play(position, find_move(position, uci))
    return position


def test_perft_from_the_start():
    assert perft(Position.from_fen(START), 3) == 8902


def test_perft_with_castling_en_passant_and_promotion():
    assert perft(Position.from_fen(KIWIPETE), 2) == 2039


def test_fen_round_trips():
    assert Position.from_fen(KIWIPETE).fen() == KIWIPETE
    assert play_line(START, "e2e4").fen() == "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"


def test_squares_are_board_cells():
    assert cell_of(parse_square("a1")) == Cell(0, 0)
    assert cell_of(parse_square("e4")) == Cell(4, 3)
    assert square_at(Cell(7, 7)) == parse_square("h8")


def test_illegal_uci_finds_nothing():
    assert find_move(Position.from_fen(START), "e2e5") is None


def test_fools_mate_is_checkmate():
    position = play_line(START, "f2f3 e7e5 g2g4 d8h4")
    assert ending_of(position, [], fifty_move_plies=100, repetitions=3, dead_positions=True) is Ending.CHECKMATE


def test_castling_moves_the_rook():
    position = play_line("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1")
    assert position.board[parse_square("f1")] == "R"
    assert position.castling == "kq"


def test_en_passant_removes_the_passed_pawn():
    position = play_line("4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1", "d7d5 e5d6")
    assert position.board[parse_square("d5")] == ""


def test_promotion_offers_four_pieces_and_names_them():
    before = Position.from_fen("8/4P3/8/8/8/8/k7/4K3 w - - 0 1")
    promotions = [move for move in legal_moves(before) if move.target == parse_square("e8")]
    assert sorted(move.promotion for move in promotions) == ["b", "n", "q", "r"]
    queen = find_move(before, "e7e8q")
    assert san(before, queen, play(before, queen)) == "e8=Q"


def test_bishops_on_one_colour_cannot_mate():
    assert insufficient_material(Position.from_fen("4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1").board) is False
    assert insufficient_material(Position.from_fen("4k3/8/8/8/8/8/8/2B1K3 w - - 0 1").board) is True
