"""Content registries: plants, husks and the chapter's gardens."""

from enum import Enum

from parallax import ContentRef, Localized, PrefabRef, content, field, record


@content("plant")
class PlantDef:
    """A seed card. Combat numbers live on the plant's prefab; this is the economy."""

    name: Localized
    blurb: Localized
    prefab: PrefabRef
    cost: int = field(min=0, doc="Pollen to plant.")
    recharge: float = field(min=0, unit="s", doc="Wait before the same seed can be planted again.")
    defends: bool = field(True, doc="False for economy plants (they don't end the first lesson).")
    tint: str = field("#e7d8ac", doc="The seed packet's band colour (CSS).")
    art: str = field("bloom", doc="Its drawing in the HUD and menus: the `ld-a-<art>` class in ui/garden.css.")


@content("husk")
class HuskDef:
    """One husk tier. Every tier shares the husk body and the husk_walker behavior."""

    name: Localized
    prefab: PrefabRef
    health: float = field(min=1)
    speed: float = field(unit="m/s")
    bite_damage: float = field(min=0)
    bite_interval: float = field(unit="s")
    bounty: int = field(min=0, doc="Score for routing it.")


class LaneRule(Enum):
    CYCLE = "cycle"
    RANDOM = "random"
    ALL = "all"
    """Every husk in the list comes down every open lane."""


@record
class WaveDef:
    husks: list[ContentRef[HuskDef]]
    lanes: LaneRule = field(LaneRule.CYCLE)
    spawn_gap: float = field(2.5, unit="s")
    banner: Localized | None = field(None, doc="Announced instead of the numbered wave banner.")


@content("level", order="number")
class LevelDef:
    """One garden of the chapter: which rows are open, which seeds you hold, what comes.
    Gardens unlock in `number` order."""

    number: int = field(min=1)
    title: Localized
    subtitle: Localized
    hint: Localized
    reward: Localized
    lanes: list[int] = field(doc="Open rows, 0-4.")
    cards: list[ContentRef[PlantDef]] = field(doc="The seed tray, in order.")
    start_pollen: int = field(min=0)
    buildup: float = field(unit="s", doc="Calm before the first wave.")
    interval: float = field(unit="s", doc="From one wave's start to the next.")
    waves: list[WaveDef]
    irrigation: bool = field(False)
    waits_for_defender: bool = field(False, doc="The first wave holds until a defender is planted.")
