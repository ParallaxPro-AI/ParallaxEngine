from parallax import SoundRef, config, field, record


@record
class HeuristicWeights:
    """Satisfies `game.well.Heuristic`, so the search takes it as is."""
    centre: float = field(doc="Per disc in the centre column.")
    open_three: float = field(doc="Three of mine and a gap in a line.")
    open_two: float = field(doc="Two of mine and two gaps in a line.")
    threat: float = field(doc="Three of theirs and a gap in a line (negative).")


@record
class Sounds:
    """The template's cues, from the hosted asset library."""
    drop: SoundRef = field(doc="A disc lands in its slot.")
    connect: SoundRef = field(doc="A line of four connects.")
    win: SoundRef = field(doc="Stinger: you won.")
    lose: SoundRef = field(doc="Stinger: teal won.")


@config("rules")
class Rules:
    """The opponent's strength and the well's pacing and geometry."""
    search_depth: int = field(min=1, doc="Plies the computer looks ahead.")
    node_budget: int = field(min=1000, doc="Most wells searched per drop.")
    heuristic: HeuristicWeights = field()
    think_seconds: float = field(min=0, unit="s")
    fall_seconds: float = field(min=0, unit="s")
    lane_y: float = field(unit="m", doc="Where a disc appears before it falls.")
    aim_bottom: float = field(unit="m", doc="Lowest world y that still aims at a column.")
    aim_top: float = field(unit="m", doc="Highest world y that still aims at a column.")
    sounds: Sounds = field()
