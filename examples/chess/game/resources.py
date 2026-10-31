from parallax import ContentRef, field, resource
from project import Content

from game.chess.status import Ending
from game.content import DifficultyDef


@resource("match", keep="scene")
class Match:
    """The game on the board. `fen` is the truth; piece entities only draw it.
    Lives for one load of the board scene, so Play again is a plain reload."""
    fen: str = field("", doc="The position in FEN; the referee sets out the opening when the board loads.")
    history: list[str] = field([], doc="Position keys so far, for threefold repetition.")
    moves: list[str] = field([], doc="The move log in algebraic notation.")
    captured: list[str] = field([], doc="Piece letters taken, in order.")
    ending: Ending | None = field(None)
    winner: str = field("", doc="WHITE, BLACK, or empty for a draw or a game in progress.")
    banner: str = field("", doc="The HUD's flash under the top edge (\"Check!\"), shown for 2 s after `banner_at`.")
    banner_at: float = field(-100.0, unit="s")


@resource("selection", keep="scene")
class Selection:
    """The player's half-made move. A pending promotion opens the picker."""
    square: int | None = field(None, doc="The picked-up piece's square.")
    promotion: str | None = field(None, doc="A pawn move waiting on the picker, in UCI without the piece (`\"e7e8\"`).")


@resource("session", keep="session")
class Session:
    """The opponent chosen on the title screen. Survives Play again; forgotten
    when the game is closed."""
    difficulty: ContentRef[DifficultyDef] = field(Content.difficulty.medium)


@resource("record", keep="profile")
class Record:
    """Lifetime results."""
    wins: int = field(0)
    losses: int = field(0)
    draws: int = field(0)
