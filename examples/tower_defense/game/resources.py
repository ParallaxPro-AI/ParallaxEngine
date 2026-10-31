"""Game-wide state."""

from enum import Enum

from parallax import ContentRef, Entity, Handle, field, resource
from project import Content

from game.content import LevelDef, TowerDef


class Result(Enum):
    PLAYING = "playing"
    WON = "won"
    LOST = "lost"


@resource("campaign")
class Campaign:
    """The battlefield picked on the map (kept through retries) and the best stars per
    battlefield (kept forever)."""

    level: ContentRef[LevelDef] = field(Content.level.meadow, keep="session")
    stars: dict[ContentRef[LevelDef], int] = field({}, keep="profile")


@resource("menu", keep="session")
class Menu:
    """Whether the title has been passed this session (the map shows after it)."""

    title_seen: bool = field(False)


@resource("purse")
class Purse:
    """Gold buys towers; lives are lost to leaks. Both start from the battlefield's row."""

    gold: int = field(0, min=0)
    lives: int = field(0, min=0)


@resource("build")
class Build:
    """The selected build pad and the tower armed for the next pad click."""

    selected: Entity | None = field(None)
    armed: ContentRef[TowerDef] | None = field(None)


@resource("siege")
class Siege:
    """Wave progress and the result."""

    wave: int = field(0, doc="Waves sent so far.")
    march: Handle | None = field(None, doc="The current wave's march, until the field is clear (not saved).")
    leaked_this_wave: bool = field(False)
    result: Result = field(Result.PLAYING)
    stars: int = field(0)
    score: int = field(0)


@resource("view")
class View:
    """Where the battlefield camera is looking (WASD / arrows pan it; Home and Recenter
    bring it back to the overview)."""

    target_x: float = field(0.0)
    target_z: float = field(0.0)
