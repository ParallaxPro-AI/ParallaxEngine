"""What the HUD announces in its own lantern glass, as the template's HUD did: toasts (a completed
chapter, a purchase, a find), the level-up banner and the combat hint under the crosshair.

Features write here and the HUD reads it (game/hud.py); the engine's own toast layer can't wear the
Sundermere look. Each line carries the time it was written, so the HUD shows it for as long as the
template did.
"""

from enum import Enum

from parallax import Context, field, record, resource


class Kind(Enum):
    QUEST = "quest"
    LEVEL = "level"
    BOUGHT = "bought"
    NOTE = "note"


@record
class Line:
    kind: Kind = field(Kind.NOTE)
    text: str = field("")
    detail: str = field("", doc="A quest's rewards, a level's subtitle, a purchase's price.")
    at: float = field(0, unit="s", doc="When it was written (ctx.time.now).")


@resource("feed", keep="scene")
class Feed:
    """The last few lines and the current combat hint."""

    lines: list[Line] = field([])
    hint: str = field("")
    hint_at: float = field(-99, unit="s")


KEPT = 4


def announce(ctx: Context, text: str, kind: Kind = Kind.NOTE, detail: str = "") -> None:
    """Queue a toast (or, for `Kind.LEVEL`, the level banner) on the HUD."""
    feed = ctx.get(Feed)
    feed.lines = [*feed.lines[-(KEPT - 1):], Line(kind=kind, text=text, detail=detail, at=ctx.time.now)]


def hint(ctx: Context, text: str) -> None:
    """Show the combat hint (italic, mid-screen, 2.5 s)."""
    feed = ctx.get(Feed)
    feed.hint = text
    feed.hint_at = ctx.time.now
