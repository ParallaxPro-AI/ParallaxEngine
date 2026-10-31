"""Game-wide state. `Loadout` and `Campaign` carry across battlefields, `BattleState`
resets with every scene, and `Career` lives on the device."""

from enum import Enum

from parallax import ContentRef, field, resource
from project import Content

from game.content import BattlefieldDef, UpgradeDef


class Phase(Enum):
    COUNTDOWN = "countdown"
    FIGHTING = "fighting"
    CLEARED = "cleared"
    WORKSHOP = "workshop"
    WON = "won"
    LOST = "lost"


@resource("campaign")
class Campaign:
    battlefield: ContentRef[BattlefieldDef] = field(Content.battlefield.iron_valley,
                                                   doc="Where the campaign is; the default is where it starts.")
    score: int = field(0)
    kills: int = field(0)


@resource("career", keep="profile")
class Career:
    """What the device remembers: the best run, lifetime kills and victories, and how far
    the unfinished campaign got (with its build), which the title's Continue resumes."""

    best_score: int = field(0)
    total_kills: int = field(0)
    victories: int = field(0)
    furthest: ContentRef[BattlefieldDef] | None = field(None, doc="None: no campaign to continue.")
    build: list[ContentRef[UpgradeDef]] = field([], doc="Loadout.picks when it got there.")


@resource("loadout")
class Loadout:
    """Every upgrade taken this campaign, folded into one set of numbers."""

    picks: list[ContentRef[UpgradeDef]] = field([])
    damage: float = field(0)
    max_health: float = field(0)
    pierce: float = field(0)
    resist: float = field(0)
    splash_radius: float = field(0, unit="m")
    splash_damage: float = field(0)
    repair_bonus: float = field(0)
    extra_ammo: int = field(0)
    reload_mul: float = field(1)
    speed_mul: float = field(1)
    traverse_mul: float = field(1)


@resource("battle", keep="scene")
class BattleState:
    phase: Phase = field(Phase.COUNTDOWN)
    wave: int = field(0)
    flawless: bool = field(True)
    offer: list[ContentRef[UpgradeDef]] = field([])
    offer_expires_at: float = field(0, unit="s", doc="Real time; the workshop freezes the game.")


@resource("announcement", keep="scene")
class Announcement:
    """The banner across the screen (the template's announcer): WAVE n with its countdown
    ring, ENGAGE!, WAVE CLEAR, a boss phase. Shown for `hold` seconds from `at`."""
    text: str = field("")
    sub: str = field("")
    style: str = field("info", choices=["info", "warn", "success", "danger"])
    hold: float = field(2.2, unit="s")
    at: float = field(-100.0, unit="s")


def announce(ctx, text: str, sub: str = "", style: str = "info", hold: float = 2.2) -> None:
    banner = ctx.get(Announcement)
    banner.text, banner.sub, banner.style, banner.hold, banner.at = text, sub, style, hold, ctx.time.now
