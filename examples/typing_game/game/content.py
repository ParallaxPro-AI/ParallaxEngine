"""Content registry: the kinds of falling packet."""

from parallax import Color, Vec3, content, field


@content("word_kind")
class WordKindDef:
    """A kind of falling packet: how it looks, how fast it falls, what it's worth,
    and how its share of the spawns grows as the run goes on."""
    color: Color = field(doc="The packet block's colour.")
    size: Vec3 = field(unit="m", doc="The packet block's size (ciphers are bigger, breaches slimmer).")
    score_mult: float = field(1.0, min=0)
    speed_mult: float = field(1.0, min=0.1)
    appears_after: float = field(0.0, unit="s", doc="Run time before this kind can spawn.")
    ramp_seconds: float = field(150.0, unit="s", min=1, doc="Time from first appearance to full share.")
    max_chance: float = field(0.0, min=0, max=1, doc="Share of spawns once fully ramped.")
