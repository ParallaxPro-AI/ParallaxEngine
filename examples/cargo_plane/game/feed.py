"""The flight HUD's toast feed, as the template draws it: each line has a kind (info,
good, bad) that colours its dot and border, lives a few seconds and at most three show.
The HUD lists `Feed.lines`; `systems/feed_clock.py` ages them out."""

from enum import Enum

from parallax import Context, field, record, resource

from game.config import FreightRules


class Kind(Enum):
    INFO = "info"
    GOOD = "good"
    BAD = "bad"


@record
class Line:
    id: int = field()
    text: str = field()
    kind: Kind = field(Kind.INFO)
    left: float = field(0, unit="s")


@resource("feed", keep="scene")
class Feed:
    lines: list[Line] = field([])
    next_id: int = field(0)


def say(ctx: Context, text: str, kind: Kind = Kind.INFO) -> None:
    rules = ctx.config(FreightRules)
    feed = ctx.get(Feed)
    feed.lines.append(Line(id=feed.next_id, text=text, kind=kind, left=rules.toast_seconds))
    feed.next_id += 1
    feed.lines = feed.lines[-rules.toast_lines:]
