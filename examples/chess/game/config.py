from parallax import PrefabRef, SoundRef, config, field


@config("rules")
class Rules:
    """Match rules and pacing."""
    fifty_move_plies: int = field(min=1)
    repetitions: int = field(min=2)
    dead_positions_draw: bool = field(doc="Insufficient material is an automatic draw.")
    node_budget: int = field(min=1000, doc="Most positions the computer searches per move.")
    think_seconds: float = field(min=0, unit="s")
    slide_seconds: float = field(min=0, unit="s")


@config("setup")
class Setup:
    """The starting position, and the prefab that draws each piece letter."""
    fen: str
    pieces: dict[str, PrefabRef]


@config("evaluation")
class Evaluation:
    """Piece values and piece-square tables (centipawns, from white's side, a1 first)."""
    piece_values: dict[str, int]
    piece_squares: dict[str, list[int]]


@config("sounds")
class Sounds:
    """The board's sounds (the template's own files, served from the ParallaxPro asset store)."""
    move: SoundRef
    capture: SoundRef
    check: SoundRef
    select: SoundRef
    win: SoundRef
    lose: SoundRef
