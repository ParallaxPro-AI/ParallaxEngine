"""Content registries: the freight on the board, the islands, the rank ladder and the
hangar upgrades. Text fields are `Localized`, written inline in each entry's JSON."""

from enum import Enum

from parallax import ContentRef, Localized, content, field


@content("rank", order="deliveries")
class RankDef:
    """A rung of the career ladder, reached by completed deliveries."""
    name: Localized = field()
    blurb: Localized = field()
    deliveries: int = field(min=0)
    pay_bonus: float = field(1, min=0)


@content("cargo")
class CargoDef:
    """A kind of freight. Fragile loads break on a heavy landing; urgent loads run on a
    much tighter clock."""
    name: Localized = field()
    blurb: Localized = field()
    pay_scale: float = field(1, min=0)
    fragile: bool = field(False)
    urgent: bool = field(False)
    min_rank: ContentRef[RankDef] | None = field(None)


@content("island")
class IslandDef:
    """An island with an airstrip and a depot. Far islands open as the pilot ranks up."""
    name: Localized = field()
    blurb: Localized = field()
    min_rank: ContentRef[RankDef] | None = field(None)


class UpgradeStat(Enum):
    GEAR = "gear"
    PAY = "pay"
    AIRFRAME = "airframe"


@content("upgrade")
class UpgradeDef:
    """A hangar purchase. "gear" raises the landing limits and "pay" raises every payout,
    per tier; an "airframe" is a one-off spare plane."""
    name: Localized = field()
    blurb: Localized = field()
    effect: Localized = field(doc="Short summary of one tier, for the shop card.")
    stat: UpgradeStat = field()
    per_tier: float = field()
    costs: list[int] = field(doc="Price of each tier in order; one entry for an airframe.")
