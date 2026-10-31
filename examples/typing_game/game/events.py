"""What happens on the grid, reported for the systems and behaviors that care."""

from parallax import ContentRef, Vec3, event

from game.content import WordKindDef


@event("word_locked")
class WordLocked:
    """A first letter chose this word as the target."""
    at: Vec3


@event("key_hit")
class KeyHit:
    at: Vec3


@event("key_missed")
class KeyMissed:
    """A wrong letter for the locked word. It costs accuracy, not the word."""
    at: Vec3


@event("word_cleared")
class WordCleared:
    at: Vec3
    kind: ContentRef[WordKindDef]
    points: int


@event("word_breached")
class WordBreached:
    at: Vec3
    kind: ContentRef[WordKindDef]


@event("combo_reached")
class ComboReached:
    """A combo milestone: every `Rules.combo_milestone` words in a row."""
    combo: int


@event("run_ended")
class RunEnded: ...
