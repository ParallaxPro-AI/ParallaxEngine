"""Game-wide state: the run, the board's interaction state and the player's records."""

from enum import Enum

from parallax import ContentRef, Handle, field, resource
from parallax.values import Cell

from game.content import GemDef, RelicDef


class Outcome(Enum):
    PLAYING = "playing"
    WON = "won"
    LOST = "lost"


@resource("run")
class Run:
    """One descent, from the first stage to a win or a stage that runs out of moves."""
    stage_index: int = field(0, min=0)
    relics: list[ContentRef[RelicDef]] = field([])
    offer: list[ContentRef[RelicDef]] = field([], doc="The relics on the draft table; the draft is open while any are.")
    run_score: int = field(0)
    stage_score: int = field(0)
    moves_left: int = field(0)
    refunded: bool = field(False, doc="A special already refunded the current move.")
    best_before: int = field(0, doc="The best run when this one started (for 'new best').")
    outcome: Outcome = field(Outcome.PLAYING)


@resource("board_state", keep="scene")
class BoardState:
    """What the board shows right now. Every stage is a fresh scene load, so it all
    starts over by itself."""
    kinds: list[ContentRef[GemDef]] = field([], doc="Gem kinds in play this stage.")
    selected: Cell | None = field(None)
    hint: list[Cell] = field([], doc="The two cells of a suggested swap, or empty.")
    chain: int = field(0, doc="Waves cleared so far in the current cascade.")
    idle: float = field(0.0, unit="s", doc="How long the board has waited with nothing selected or hinted.")
    resolving: Handle | None = field(None, doc="The swap being played out (not saved).")


@resource("records", keep="profile")
class Records:
    best_run: int = field(0)
    best_stage: int = field(0, doc="Furthest stage ever cleared.")
