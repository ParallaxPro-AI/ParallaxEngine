"""The run in progress, the open draft, the title's choice for the next run, and the
player's records and shrine (kept forever)."""

from enum import Enum

from parallax import ContentRef, field, resource

from game.content import EntranceDef, PerkDef, UpgradeDef


class Outcome(Enum):
    SURVIVED = "survived"
    FELL = "fell"


@resource("run")
class Run:
    next_surge_at: float = field(0, unit="s", doc="Game time the next surge boils out.")
    score: float = field(0)
    kills: int = field(0)
    combo: float = field(1)
    last_kill_at: float = field(-99, unit="s")
    level: int = field(1)
    xp: float = field(0)
    pending_drafts: int = field(0)
    entrances_fired: list[ContentRef[EntranceDef]] = field([])
    outcome: Outcome | None = field(None)
    dust_earned: int = field(0)
    new_best: bool = field(False)
    alert: str = field("", doc="The HUD banner's text.")
    alert_until: float = field(0, unit="s")
    kill_fx_at: float = field(0, unit="s", doc="Game time the next kill-spark burst may play.")
    kill_sound_at: float = field(0, unit="s")


@resource("draft")
class Draft:
    cards: list[ContentRef[UpgradeDef]] = field([], doc="The hand on the table; the draft panel is open while it's dealt.")
    rerolls: int = field(0)
    stacks: dict[ContentRef[UpgradeDef], int] = field({})


@resource("choices", keep="session")
class Choices:
    """What the title screen set up for the next run; survives every run reset."""
    vigil: bool = field(False, doc="Ashen Vigil: the heavier horde.")


@resource("records", keep="profile")
class Records:
    dust: int = field(0)
    perk_levels: dict[ContentRef[PerkDef], int] = field({})
    best_score: int = field(0)
    best_seconds: int = field(0)
    best_level: int = field(0)
    runs_survived: int = field(0)
    vigil_survived: int = field(0)
    last_seed: int = field(0)
