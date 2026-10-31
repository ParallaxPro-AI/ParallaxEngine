"""What happens on the board, reported for the systems and panels that care."""

from parallax import Vec2, event


@event("board_dealt")
class BoardDealt:
    """A fresh board with its starting tiles."""


@event("slid")
class Slid:
    """The board moved (a slide that changed nothing is not reported). `fused`: at
    least one pair of tiles fused in it."""
    fused: bool


@event("tiles_fused")
class TilesFused:
    at: Vec2
    value: int


@event("tile_spawned")
class TileSpawned:
    at: Vec2


@event("milestone_reached")
class MilestoneReached:
    """A new highest tile at least `Rules.milestone` was forged (at most once per slide)."""
    value: int


@event("game_ended")
class GameEnded:
    won: bool
