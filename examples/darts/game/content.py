from parallax import Localized, content, field


@content("leg", order="number")
class LegDef:
    """One leg of the nine-leg card: a number to count down to zero."""
    number: int = field(min=1, doc="Order on the card.")
    name: Localized
    blurb: Localized
    start: int = field(min=2, doc="Points to check out.")
    par: int = field(min=1, doc="Darts a steady player needs.")


@content("tier", order="rank")
class TierDef:
    """A rung of the Tour. Winning a match inside the dart budget opens the next."""
    rank: int = field(min=0)
    name: Localized
    blurb: Localized
    budget_over_par: int = field(min=0, doc="Darts of slack over the card's par.")
    draught_scale: float = field(1.0, min=0)
    score_mult: float = field(1.0, min=0)


@content("condition")
class ConditionDef:
    """A kind of air in the hall, rolled at the start of every leg."""
    name: Localized
    weight: float = field(1, min=0, doc="Relative chance of being rolled.")
    speed_min: float = field(unit="m/s")
    speed_max: float = field(unit="m/s")


@content("grade", order="max_over_par")
class GradeDef:
    """How a checked-out leg pays, by darts over par. The first grade (best) whose
    limit the leg is within wins."""
    name: Localized
    max_over_par: int
    points: int


@content("skill")
class SkillDef:
    """A bonus for a single dart or a finish."""
    name: Localized
    points: int
    min_start: int = field(0, doc="Checkout only: the leg must have started at least this high.")


@content("penalty")
class PenaltyDef:
    name: Localized
    points: int


def par_total(ctx) -> int:
    return sum(leg.data.par for leg in ctx.content(LegDef))
