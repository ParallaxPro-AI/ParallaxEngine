"""What happens in the yard, reported for the systems and panels that care."""

from parallax import event


@event("stepped")
class Stepped:
    """The bot moved one cell, maybe pushing a crate."""
    pushed: bool
    docked: bool
    """A crate landed on a pad."""
    undocked: bool
    """A crate was pushed off a pad."""


@event("bumped")
class Bumped:
    """A step into a wall or an immovable crate."""


@event("move_undone")
class MoveUndone: ...


@event("level_reset")
class LevelReset: ...


@event("level_solved")
class LevelSolved:
    level: int
    """1-based."""


@event("shift_completed")
class ShiftCompleted:
    moves: int
