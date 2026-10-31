"""Game-wide state: the shift in progress, the attempt at the current level, and the
player's records."""

from parallax import field, resource


@resource("shift")
class Shift:
    """One run through the levels."""
    level_index: int = field(0, doc="The level being played (0-based).")
    started_at: int = field(0, doc="The level this shift started on (resumed shifts don't set records).")
    total_moves: int = field(0)
    complete: bool = field(False, doc="Every level is cleared; the result panel follows this.")
    new_record: bool = field(False, doc="The finished shift beat the fewest-moves record.")
    previous_best: int = field(0, doc="The record the finished shift beat (0 = there was none).")
    introduced: int = field(-1, doc="The last level whose intro card was shown.")


@resource("attempt", keep="scene")
class Attempt:
    """The current try at a level. A level (and a reset) is a fresh load of the yard
    scene, so all of it starts over by itself."""
    moves: int = field(0)
    pushes: int = field(0)
    history: list[str] = field([], doc="This level's moves in LURD notation, oldest first.")
    redo: list[str] = field([], doc="Moves taken back with undo, most recent last.")
    intro: bool = field(False, doc="This load starts a new level, so the HUD's level card sweeps in.")


@resource("records", keep="profile")
class Records:
    best_moves: int = field(0, doc="Fewest moves for a whole shift from level 1; 0 = none yet.")
    best_levels: int = field(0, doc="Furthest level ever reached.")
    resume_level: int = field(0, doc="Where Continue picks up (0-based).")
