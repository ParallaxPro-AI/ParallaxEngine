"""Game-wide state: the current game and the player's records."""

from enum import Enum

from parallax import field, resource


class Outcome(Enum):
    PLAYING = "playing"
    WON = "won"
    LOST = "lost"


@resource("score")
class Score:
    """One game, from the first two tiles to the target tile or a jammed board."""
    points: int = field(0)
    highest: int = field(0, doc="The biggest tile on the board.")
    best_before: int = field(0, doc="The best score when this game started (for 'new best').")
    scored_slides: int = field(0, doc="Slides that scored; the HUD bumps its score on each.")
    outcome: Outcome = field(Outcome.PLAYING)


@resource("records", keep="profile")
class Records:
    best_score: int = field(0)
    best_tile: int = field(0)
