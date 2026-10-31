"""Move generation and making moves: attacks, legal moves, castling, en passant
and promotion."""

from game.chess.position import (
    BLACK, WHITE, Move, Position, color_of, file_of, on_board, opponent, piece_of,
    rank_of, square,
)

KNIGHT_STEPS = ((1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2))
KING_STEPS = ((1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1))
ROOK_RAYS = ((1, 0), (-1, 0), (0, 1), (0, -1))
BISHOP_RAYS = ((1, 1), (-1, 1), (1, -1), (-1, -1))
PROMOTIONS = "qrbn"

# Moving from or capturing on one of these squares costs these castling rights.
RIGHTS_LOST = {4: "KQ", 0: "Q", 7: "K", 60: "kq", 56: "q", 63: "k"}


def legal_moves(position: Position) -> list[Move]:
    """Every move the side to move may play: pseudo-legal moves that don't leave
    its own king attacked."""
    return [move for move in _pseudo_legal_moves(position) if not _exposes_king(position, move)]


def moves_from(position: Position, sq: int) -> list[Move]:
    """The legal moves of the piece on `sq` (four per promoting pawn push)."""
    return [move for move in legal_moves(position) if move.origin == sq]


def find_move(position: Position, uci: str) -> Move | None:
    """The legal move written `uci` (`"e2e4"`, `"e7e8q"`), or None if there is none."""
    return next((move for move in legal_moves(position) if move.uci() == uci), None)


def play(position: Position, move: Move) -> Position:
    """The position after `move`. The move must be legal in `position`."""
    board = list(position.board)
    mover = board[move.origin]
    victim = board[captured_square(move)]
    board[captured_square(move)] = ""
    board[move.origin] = ""
    board[move.target] = piece_of(position.turn, move.promotion) if move.promotion else mover
    if move.castle:
        rook_from, rook_to = rook_hop(move)
        board[rook_to], board[rook_from] = board[rook_from], ""

    is_pawn = mover.lower() == "p"
    double_step = is_pawn and abs(move.target - move.origin) == 16
    lost = RIGHTS_LOST.get(move.origin, "") + RIGHTS_LOST.get(move.target, "")
    return Position(
        board=tuple(board),
        turn=opponent(position.turn),
        castling="".join(right for right in position.castling if right not in lost),
        en_passant=(move.origin + move.target) // 2 if double_step else -1,
        halfmove_clock=0 if is_pawn or victim else position.halfmove_clock + 1,
        fullmove=position.fullmove + (1 if position.turn == BLACK else 0),
    )


def captured_square(move: Move) -> int:
    """Where the captured piece stands: the target, except for en passant."""
    if move.en_passant:
        return square(file_of(move.target), rank_of(move.origin))
    return move.target


def rook_hop(move: Move) -> tuple[int, int]:
    """The rook's (from, to) squares for a castling move."""
    corner = move.origin - 4
    return (corner + 7, corner + 5) if move.castle == "K" else (corner, corner + 3)


def in_check(position: Position) -> bool:
    return is_attacked(position.board, king_square(position.board, position.turn), opponent(position.turn))


def king_square(board: tuple[str, ...], color: str) -> int:
    return board.index(piece_of(color, "k"))


def is_attacked(board: tuple[str, ...], sq: int, by: str) -> bool:
    """Is `sq` attacked by any piece of color `by`?"""
    file, rank = file_of(sq), rank_of(sq)
    pawn_rank = rank - (1 if by == WHITE else -1)
    for df in (-1, 1):
        if on_board(file + df, pawn_rank) and board[square(file + df, pawn_rank)] == piece_of(by, "p"):
            return True
    for kind, steps in (("n", KNIGHT_STEPS), ("k", KING_STEPS)):
        for df, dr in steps:
            if on_board(file + df, rank + dr) and board[square(file + df, rank + dr)] == piece_of(by, kind):
                return True
    for kinds, rays in (("rq", ROOK_RAYS), ("bq", BISHOP_RAYS)):
        for df, dr in rays:
            blocker = _first_piece_along(board, file, rank, df, dr)
            if blocker and color_of(blocker) == by and blocker.lower() in kinds:
                return True
    return False


def _first_piece_along(board: tuple[str, ...], file: int, rank: int, df: int, dr: int) -> str:
    file, rank = file + df, rank + dr
    while on_board(file, rank):
        if board[square(file, rank)]:
            return board[square(file, rank)]
        file, rank = file + df, rank + dr
    return ""


def _exposes_king(position: Position, move: Move) -> bool:
    after = play(position, move)
    return is_attacked(after.board, king_square(after.board, position.turn), after.turn)


def _pseudo_legal_moves(position: Position) -> list[Move]:
    moves = []
    for sq, piece in enumerate(position.board):
        if piece and color_of(piece) == position.turn:
            moves.extend(_piece_moves(position, sq, piece.lower()))
    return moves


def _piece_moves(position: Position, sq: int, kind: str) -> list[Move]:
    if kind == "p":
        return _pawn_moves(position, sq)
    if kind == "n":
        return _steps(position, sq, KNIGHT_STEPS)
    if kind == "b":
        return _slides(position, sq, BISHOP_RAYS)
    if kind == "r":
        return _slides(position, sq, ROOK_RAYS)
    if kind == "q":
        return _slides(position, sq, ROOK_RAYS + BISHOP_RAYS)
    return _steps(position, sq, KING_STEPS) + _castles(position, sq)


def _can_enter(position: Position, sq: int) -> bool:
    piece = position.board[sq]
    return not piece or color_of(piece) != position.turn


def _steps(position: Position, sq: int, steps: tuple[tuple[int, int], ...]) -> list[Move]:
    file, rank = file_of(sq), rank_of(sq)
    return [
        Move(sq, square(file + df, rank + dr))
        for df, dr in steps
        if on_board(file + df, rank + dr) and _can_enter(position, square(file + df, rank + dr))
    ]


def _slides(position: Position, sq: int, rays: tuple[tuple[int, int], ...]) -> list[Move]:
    moves = []
    for df, dr in rays:
        file, rank = file_of(sq) + df, rank_of(sq) + dr
        while on_board(file, rank):
            target = square(file, rank)
            if _can_enter(position, target):
                moves.append(Move(sq, target))
            if position.board[target]:
                break
            file, rank = file + df, rank + dr
    return moves


def _pawn_moves(position: Position, sq: int) -> list[Move]:
    file, rank = file_of(sq), rank_of(sq)
    forward = 1 if position.turn == WHITE else -1
    home_rank, last_rank = (1, 7) if position.turn == WHITE else (6, 0)
    next_rank = rank + forward
    moves = []

    ahead = square(file, next_rank)
    if not position.board[ahead]:
        moves += _arrive(sq, ahead, next_rank == last_rank)
        two_ahead = square(file, rank + 2 * forward)
        if rank == home_rank and not position.board[two_ahead]:
            moves.append(Move(sq, two_ahead))

    for df in (-1, 1):
        if not on_board(file + df, next_rank):
            continue
        target = square(file + df, next_rank)
        victim = position.board[target]
        if victim and color_of(victim) != position.turn:
            moves += _arrive(sq, target, next_rank == last_rank)
        elif target == position.en_passant:
            moves.append(Move(sq, target, en_passant=True))
    return moves


def _arrive(origin: int, target: int, promotes: bool) -> list[Move]:
    if promotes:
        return [Move(origin, target, promotion=kind) for kind in PROMOTIONS]
    return [Move(origin, target)]


def _castles(position: Position, sq: int) -> list[Move]:
    corner = 0 if position.turn == WHITE else 56
    enemy = opponent(position.turn)
    if sq != corner + 4 or is_attacked(position.board, sq, enemy):
        return []
    moves = []
    # (side, squares that must be empty, squares the king crosses and lands on)
    for side, empty, path in (("K", (5, 6), (5, 6)), ("Q", (1, 2, 3), (3, 2))):
        right = side if position.turn == WHITE else side.lower()
        if (right in position.castling
                and not any(position.board[corner + i] for i in empty)
                and not any(is_attacked(position.board, corner + i, enemy) for i in path)):
            moves.append(Move(sq, corner + path[-1], castle=side))
    return moves
