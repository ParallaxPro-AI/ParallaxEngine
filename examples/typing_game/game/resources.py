"""Game-wide state: the run and the player's records."""

from parallax import ContentRef, Entity, Vec2, field, record, resource

from game.content import WordKindDef


@record
class ScorePop:
    """A "+points" the HUD floats up from where a word was purged."""
    at: Vec2 = field(doc="Across and down the HUD's word field, 0..1.")
    points: int = field()
    kind: ContentRef[WordKindDef] = field()
    time: float = field(unit="s", doc="Run time it was scored.")


@resource("run")
class Run:
    """One run, from the first word to the breach that takes the last life."""
    score: int = field(0)
    combo: int = field(0)
    max_combo: int = field(0)
    cleared: int = field(0)
    breached: int = field(0)
    keys_total: int = field(0)
    keys_correct: int = field(0)
    target: Entity | None = field(None, doc="The word being typed, once its first letter is struck.")
    new_best: bool = field(False, doc="The finished run beat the best score.")

    # When things last happened (run time), for the HUD's one-shot animations.
    missed_at: float = field(-100.0, unit="s", doc="The last wrong letter.")
    cleared_at: float = field(-100.0, unit="s", doc="The last purge.")
    milestone_at: float = field(-100.0, unit="s", doc="The last combo milestone.")
    milestone: int = field(0, doc="The combo that milestone celebrated.")
    pops: list[ScorePop] = field([], doc="The latest score pops, oldest first.")


@resource("records", keep="profile")
class Records:
    best_score: int = field(0)
    best_wpm: int = field(0)
    best_combo: int = field(0)
