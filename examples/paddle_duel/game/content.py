"""Content registries: the rivals of the gauntlet and the perk pool. Names, taglines
and descriptions are written inline in each entry's JSON."""

from parallax import Color, Localized, content, field


@content("rival", order="number")
class RivalDef:
    """One duel's opponent. Better rivals move faster, re-read the ball sooner, misjudge
    it by less and lead it further."""
    number: int = field(min=1, doc="Position in the gauntlet.")
    name: Localized = field()
    tagline: Localized = field()
    color: Color = field(doc="Tints the rival paddle and the goal it defends.")
    speed: float = field(unit="m/s")
    aim_error: float = field(unit="m", doc="Largest misjudgement of where the ball will be.")
    reaction_time: float = field(unit="s", min=0.05, doc="How often the rival re-reads the ball.")
    predict: float = field(0.0, min=0, max=1, doc="How far ahead it leads the ball.")
    ball_speed_scale: float = field(1.0, min=0.1)


@content("perk")
class PerkDef:
    """A between-duel upgrade. Multipliers stack for the rest of the run."""
    name: Localized = field()
    description: Localized = field()
    paddle_length: float = field(1.0, min=0.1)
    paddle_speed: float = field(1.0, min=0.1)
    english: float = field(1.0, min=0.1)
    charge_boost: float = field(1.0, min=0.1)
    charge_rate: float = field(1.0, min=0.1)
    rally_score: float = field(1.0, min=0)
    return_speed: float = field(1.0, min=0.1)
    ball_accel: float = field(1.0, min=0)
    shields: int = field(0, min=0, doc="Rival points refunded in every duel.")
