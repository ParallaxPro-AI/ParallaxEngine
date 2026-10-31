"""Content registries: obstacles, districts, power-ups and Lock-Up upgrades."""

from enum import Enum
from typing import Literal

from parallax import Color, ContentRef, Localized, PrefabRef, SoundRef, content, field


class Avoid(Enum):
    """The rule that clears an obstacle."""

    SWITCH_LANE = "switch_lane"
    JUMP = "jump"
    SLIDE = "slide"


class PowerUpEffect(Enum):
    COIN_MAGNET = "coin_magnet"
    SHIELD = "shield"
    SCORE_MULTIPLIER = "score_multiplier"
    SPRINT = "sprint"
    GUARD_SETBACK = "guard_setback"


class UpgradeEffect(Enum):
    GUARD_HEADROOM = "guard_headroom"
    GUARD_RECOVER = "guard_recover"
    MAGNET_RADIUS = "magnet_radius"
    COIN_VALUE = "coin_value"
    START_SHIELD = "start_shield"
    STREET_MAPS = "street_maps"


@content("obstacle")
class ObstacleDef:
    """Something in the street, and how it's cleared: side-step it, jump it, or
    slide under it."""

    prefab: PrefabRef
    avoid: Avoid
    lanes_blocked: int = field(1, min=1, max=3, doc="A switch_lane row always leaves one lane open.")
    weight: float = field(1, min=0)
    from_distance: float = field(0, unit="m", doc="Metres run before it can appear.")
    hard: bool = field(False, doc="Hard rows gain weight as the run deepens.")
    half_width: float = field(0.98, unit="m")
    half_depth: float = field(0.48, unit="m")
    clearance: float = field(0, unit="m", doc="Jump rows: feet above this height clear it.")


@content("district", order="end_distance")
class DistrictDef:
    """One stretch of the escape: its pace, its look and its rhythm.
    `encounters` is an authored sequence of obstacle ids, with `rest` beats."""

    name: Localized
    blurb: Localized
    tint: Color = field(doc="Its colour on the HUD and the end card.")
    end_distance: float = field(unit="m", doc="Cumulative.")
    speed_scale: float = field(1)
    gap_scale: float = field(1)
    hard_bias: float = field(0)
    powerup_scale: float = field(1)
    fog_color: Color
    fog_near: float = field(unit="m", doc="Linear fog: clear out to here, opaque at `fog_far`.")
    fog_far: float = field(unit="m")
    road: PrefabRef
    buildings: list[PrefabRef]
    landmark: PrefabRef | None = field(None, doc="A set piece every other building slot (stall, sign, crane, boat).")
    landmark_x: float = field(6.6, unit="m", doc="How far off the centre line the landmark stands.")
    waterfront: bool = field(False, doc="The right side is the harbour: no buildings there, the landmark only there.")
    encounters: list[ContentRef[ObstacleDef] | Literal["rest"]]


@content("powerup")
class PowerUpDef:
    """A pickup on the street. Timed ones (`seconds` > 0) run as buffs; the rest act at once."""

    name: Localized
    prefab: PrefabRef
    effect: PowerUpEffect
    seconds: float = field(0, unit="s", doc="0 = instant.")
    power: float = field(1)
    weight: float = field(1, min=0)
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@content("upgrade")
class UpgradeDef:
    """A permanent Lock-Up upgrade. `costs[i]` buys level i + 1."""

    name: Localized
    blurb: Localized
    icon: str = field(doc="SVG path data (24×24) for its Lock-Up tile.")
    effect: UpgradeEffect
    per_level: float
    costs: list[int]
