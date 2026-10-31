"""Squares, moves and positions.

A square is an index 0..63 with a1 = 0, h1 = 7, a8 = 56 — the search walks
64-entry tuples hundreds of thousands of times a move, so squares stay plain
ints here. `cell_of` / `square_at` name the same square as a board `Cell`
(file, rank) for the game layer. A piece is its FEN letter: upper case for
white (`"N"`), lower case for black (`"n"`); an empty square is `""`.

Positions and moves have standard text forms, FEN and UCI. The game stores and
sends those (`Match.fen`, `MoveChosen.move`), so these frozen classes never
have to be engine field types.
"""

from dataclasses import dataclass

from parallax.values import Cell

WHITE = "w"
BLACK = "b"
EMPTY_BOARD = ("",) * 64


def opponent(color: str) -> str:
    return BLACK if color == WHITE else WHITE


def color_of(piece: str) -> str:
    return WHITE if piece.isupper() else BLACK


def piece_of(color: str, kind: str) -> str:
    """`piece_of(WHITE, "q") == "Q"`."""
    return kind.upper() if color == WHITE else kind


def square(file: int, rank: int) -> int:
    return rank * 8 + file


def file_of(sq: int) -> int:
    return sq % 8


def rank_of(sq: int) -> int:
    return sq // 8


def on_board(file: int, rank: int) -> bool:
    return 0 <= file < 8 and 0 <= rank < 8


def cell_of(sq: int) -> Cell:
    """The square as a board cell: (file, rank), a1 = Cell(0, 0)."""
    return Cell(file_of(sq), rank_of(sq))


def square_at(cell: Cell) -> int:
    return square(cell.col, cell.row)


def square_name(sq: int) -> str:
    return "abcdefgh"[file_of(sq)] + str(rank_of(sq) + 1)


def parse_square(name: str) -> int:
    """`"e4"` -> 28; `"-"` (FEN for "none") -> -1."""
    if name == "-":
        return -1
    return square("abcdefgh".index(name[0]), int(name[1]) - 1)


@dataclass(frozen=True)
class Move:
    origin: int
    target: int
    promotion: str = ""
    """Lower-case kind the pawn becomes ("q", "r", "b", "n"), or ""."""
    castle: str = ""
    """"K" (king side) or "Q" (queen side) when the king castles."""
    en_passant: bool = False

    def uci(self) -> str:
        """`"e2e4"`, `"e7e8q"`: the move as the game's events carry it."""
        return square_name(self.origin) + square_name(self.target) + self.promotion


@dataclass(frozen=True)
class Position:
    board: tuple[str, ...]
    turn: str = WHITE
    castling: str = "KQkq"
    """The castling rights still held, in FEN order."""
    en_passant: int = -1
    """The square a pawn skipped over last move, or -1."""
    halfmove_clock: int = 0
    """Plies since the last capture or pawn move (the fifty-move rule)."""
    fullmove: int = 1

    @staticmethod
    def from_fen(fen: str) -> "Position":
        placement, turn, castling, en_passant, halfmove, fullmove = fen.split()
        board = list(EMPTY_BOARD)
        for row, rank_text in enumerate(placement.split("/")):
            file = 0
            for char in rank_text:
                if char.isdigit():
                    file += int(char)
                else:
                    board[square(file, 7 - row)] = char
                    file += 1
        return Position(
            board=tuple(board),
            turn=turn,
            castling="" if castling == "-" else castling,
            en_passant=parse_square(en_passant),
            halfmove_clock=int(halfmove),
            fullmove=int(fullmove),
        )

    def fen(self) -> str:
        """The position as FEN, the inverse of `from_fen`."""
        ranks = []
        for rank in range(7, -1, -1):
            text, empty = "", 0
            for file in range(8):
                piece = self.board[square(file, rank)]
                if piece:
                    text += (str(empty) if empty else "") + piece
                    empty = 0
                else:
                    empty += 1
            ranks.append(text + (str(empty) if empty else ""))
        en_passant = square_name(self.en_passant) if self.en_passant >= 0 else "-"
        castling = self.castling or "-"
        return f"{'/'.join(ranks)} {self.turn} {castling} {en_passant} {self.halfmove_clock} {self.fullmove}"

    def key(self) -> str:
        """What makes two positions "the same" for threefold repetition."""
        placement = "".join(piece or "." for piece in self.board)
        return f"{placement} {self.turn} {self.castling} {self.en_passant}"
