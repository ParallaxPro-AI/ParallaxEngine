from parallax import Localized, content, field


@content("difficulty", order="order")
class DifficultyDef:
    """One computer opponent offered on the title screen."""
    order: int = field(doc="Position on the title screen.")
    name: Localized
    blurb: Localized
    depth: int = field(2, min=1, max=6, doc="Deepest search, in plies.")
    positional: float = field(1.0, min=0, doc="Weight of the piece-square tables; 0 = material only.")
    blunder: float = field(0.0, min=0, max=1, doc="Chance per move of playing a random legal move.")
    aggression: float = field(0.0, min=0, doc="Extra pull toward captures.")
