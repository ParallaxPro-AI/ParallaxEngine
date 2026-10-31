"""What happens in a run, reported for the systems and panels that care."""

from parallax import ContentRef, Vec3, event
from parallax.values import Cell

from game.content import GemDef, RelicDef


@event("swap_made")
class SwapMade:
    """A swap made a match and costs a move."""
    a: Cell
    b: Cell


@event("swap_rejected")
class SwapRejected:
    """A swap made no match and slid back. No move is spent."""


@event("gem_shattered")
class GemShattered:
    at: Vec3
    kind: ContentRef[GemDef]


@event("wave_cleared")
class WaveCleared:
    """One step of a cascade resolved."""
    chain: int
    gems: int
    crust: int
    """Crust layers chipped."""
    forged: int
    """Special gems created."""
    detonated: bool


@event("board_settled")
class BoardSettled:
    """A swap has fully played out and the board is waiting for the player again."""


@event("stage_cleared")
class StageCleared:
    stage: int
    """1-based."""


@event("relic_picked")
class RelicPicked:
    """A card on the relic draft (the card's `relic` id fills the field)."""
    relic: ContentRef[RelicDef]


@event("run_ended")
class RunEnded:
    won: bool
