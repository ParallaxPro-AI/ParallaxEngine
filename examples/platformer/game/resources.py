"""Game-wide state: the attempt at the current level, the hub menu, the profile."""

from enum import Enum

from parallax import ContentRef, PrefabRef, Vec3, field, record, resource

from game.content import LevelDef


class Mode(Enum):
    EXPLORE = "explore"
    """Deaths are free."""
    CHALLENGE = "challenge"
    """Deaths cost lives; the last one fails the level."""


@record
class Regrowth:
    """A crumbled block waiting to come back."""

    prefab: PrefabRef
    at: Vec3
    due: float = field(unit="s")


@resource("attempt")
class Attempt:
    """One attempt at one level. Every level load is a `new_run=True`."""

    level: ContentRef[LevelDef] | None = field(None)
    started_at: float = field(0, unit="s")
    score: int = field(0)
    coins: int = field(0)
    keepsakes: int = field(0)
    keepsakes_total: int = field(0)
    chain: float = field(1.0)
    chain_until: float = field(0, unit="s")
    lives: int = field(0)
    deaths: int = field(0)
    spawn: Vec3 = field(Vec3.ZERO, doc="Where a death sends you: the last checkpoint.")
    grace_until: float = field(0, unit="s")
    dead: bool = field(False)
    respawn_at: float = field(0, unit="s", doc="When a dead hero comes back: after the death beat.")
    regrowing: list[Regrowth] = field([])
    ended: bool = field(False)
    won: bool = field(False)
    time: float = field(0, unit="s")
    time_bonus: int = field(0)
    stars: int = field(0)
    new_best: bool = field(False)
    notice: str = field("")
    notice_until: float = field(0, unit="s")
    tips_shown: int = field(0)


def playing(ctx) -> bool:
    """True until the attempt is cleared or failed."""
    return not ctx.get(Attempt).ended


def alive(ctx) -> bool:
    """True while the hero is in play: not between a death and its respawn."""
    attempt = ctx.get(Attempt)
    return not attempt.ended and not attempt.dead


@resource("hub_menu", keep="scene")
class HubMenu:
    """What the hub shows. Leaving a level loads the hub with
    `init=[HubMenu(level_list=True)]`, so it opens on the level list."""

    level_list: bool = field(False)


@resource("profile", keep="profile")
class Profile:
    """Settings and per-level records. Kept on the device forever."""

    mode: Mode = field(Mode.EXPLORE)
    shake: bool = field(True)
    best: dict[ContentRef[LevelDef], int] = field({})
    stars: dict[ContentRef[LevelDef], int] = field({})
    keepsakes: dict[ContentRef[LevelDef], int] = field({})
