"""Content registries: stages, hazards, gap rhythms and outfits."""

from enum import Enum

from parallax import Color, ContentRef, Localized, PrefabRef, content, field


class Lane(Enum):
    """Where a hazard rides, and so how it is cleared."""

    GROUND = "ground"
    """On the floor: hop it."""
    AIR = "air"
    """At chest height: duck it (or hop it with tight timing)."""


@content("obstacle")
class ObstacleDef:
    """One kind of hazard."""

    name: Localized
    counter: Localized = field(doc="The verb the HUD teaches as it approaches; similar hazards share it.")
    prefab: PrefabRef
    lane: Lane = field(Lane.GROUND)
    height_min: float = field(1, unit="m", doc="Rolled per spawn; sprites are authored 1 m tall.")
    height_max: float = field(1, unit="m")
    air_y: float = field(0, unit="m", doc="Centre height of an air hazard.")


@content("stage", order="from_distance")
class StageDef:
    """A stretch of canyon: how fast it gets, how tight its rhythm is, which
    hazards may appear in it and how it is painted."""

    name: Localized
    subtitle: Localized
    from_distance: float = field(unit="m")
    speed_cap: float = field(unit="m/s")
    speed_ramp: float = field(unit="m/s²")
    gap_scale: float = field(1, min=0.5, doc="Multiplies every gap rhythm.")
    air_chance: float = field(0, min=0, max=1)
    coin_chance: float = field(0.5, min=0, max=1)
    sky: Color
    ground: Color
    weights: dict[ContentRef[ObstacleDef], float] = field(doc="Relative pick weight per hazard.")


@content("gap_rhythm")
class GapRhythmDef:
    """A bucket of gap lengths, in SECONDS of travel (tight / normal / breather)."""

    weight: float
    min_seconds: float = field(unit="s")
    max_seconds: float = field(unit="s")


@content("outfit", order="cost")
class OutfitDef:
    """A courier outfit sold in the Outfitter. Purely cosmetic: a tint."""

    name: Localized
    blurb: Localized
    cost: int = field(0, min=0)
    requires: ContentRef["OutfitDef"] | None = field(None)
    tint: Color = field(Color.WHITE)
    swatch: Color = field(Color.WHITE, doc="The Outfitter card's figure colour (the template's CSS swatch).")
