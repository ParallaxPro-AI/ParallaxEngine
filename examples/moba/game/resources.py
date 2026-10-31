from enum import Enum

from parallax import Context, Tag, field, record, resource


class Phase(Enum):
    WAITING = "waiting"
    """The arena before anyone has joined."""
    DRAFT = "draft"
    PLAYING = "playing"
    ENDED = "ended"


@record
class FeedLine:
    """One kill-feed row: a champion, tower, core or camp kill (a minion dying is not news)."""
    killer: str = field("")
    victim: str = field("")
    killer_side: Tag | None = field(None)
    victim_side: Tag | None = field(None)
    at: float = field(0, unit="s", doc="Match time of the kill.")


@record
class Banner:
    """The announcer's line (the template's hud/announcer): drawn by the HUD for a few
    seconds after `at`. `style` colours it: gold (kills, streaks), danger, success, info;
    "kill" is gold for the killer's team and danger for the other."""
    text: str = field("")
    style: str = field("gold")
    side: Tag | None = field(None, doc="The team a kill banner is good news for.")
    small: bool = field(False)
    at: float = field(-100, unit="s")


@resource("match", keep="scene")
class Match:
    """The state of the match every client sees. It starts over with each load of
    the arena."""
    phase: Phase = field(Phase.WAITING, replicate=True)
    draft_ends_at: float = field(0, unit="s", replicate=True)
    started_at: float = field(0, unit="s", replicate=True)
    winner: Tag | None = field(None, replicate=True)
    blue_kills: int = field(0, replicate=True)
    red_kills: int = field(0, replicate=True)
    ended_at: float = field(0, unit="s", replicate=True)
    blue_towers: int = field(0, replicate=True, doc="Red towers Blue has destroyed.")
    red_towers: int = field(0, replicate=True, doc="Blue towers Red has destroyed.")
    blue_core_exposed: bool = field(False, replicate=True, doc="Both of Blue's base towers are down.")
    red_core_exposed: bool = field(False, replicate=True)
    banner: Banner = field(Banner(), replicate=True)
    feed: list[FeedLine] = field([], replicate=True, doc="The newest kill-feed rows, oldest first.")
    opening_strike_taken: bool = field(False)


def playing(ctx: Context) -> bool:
    """A run condition for systems that only work while the match is live."""
    return ctx.get(Match).phase is Phase.PLAYING


FEED_LINES = 5
"""Kill-feed rows the match keeps (the template's MAX)."""


def announce(ctx: Context, text: str, style: str = "gold", *, side: Tag | None = None, small: bool = False) -> None:
    """Puts a line on every player's announcer banner (server)."""
    ctx.get(Match).banner = Banner(text=text, style=style, side=side, small=small, at=ctx.time.now)


def log_kill(ctx: Context, killer: str, victim: str, killer_side: Tag | None, victim_side: Tag | None) -> None:
    """Adds a kill-feed row (server)."""
    match = ctx.get(Match)
    line = FeedLine(killer=killer, victim=victim, killer_side=killer_side, victim_side=victim_side,
                    at=ctx.time.now - match.started_at)
    match.feed = (list(match.feed) + [line])[-FEED_LINES:]


@resource("session", keep="session")
class Session:
    """This player's own menu choice, kept across scene loads (never replicated)."""
    training: bool = field(False, doc="Training with Bots: the match is offline and the menu pauses it.")
