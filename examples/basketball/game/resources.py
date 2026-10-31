"""Game-wide state: tonight's game, the run up the ladder, and the career record."""

from enum import Enum

from parallax import ContentRef, Context, field, resource

from game.content import Perk


class Phase(Enum):
    PLAYING = "playing"
    BREAK = "break"         # before a period: the tip-off, or between quarters
    OVER = "over"


class Result(Enum):
    RUNNING = "running"
    CHAMPIONS = "champions"
    ELIMINATED = "eliminated"


@resource("match")
class Match:
    """The game on the court right now. Reset at every tip-off: it starts as a break
    that is already over, so the game clock opens the first quarter on its next tick."""

    phase: Phase = field(Phase.BREAK)
    quarter: int = field(0, doc="The period being played, or just played during a break.")
    overtime: int = field(0)
    clock: float = field(0, unit="s")
    break_left: float = field(0, unit="s")
    home_score: int = field(0)
    away_score: int = field(0)
    banner: str = field("", doc="The scoreboard's banner (bucket, period, shot clock); shown for 2.2 s after `banner_at`.")
    banner_sub: str = field("")
    banner_tint: str = field("var(--cc-chalk)", doc="CSS colour of the banner's rule: chalk, accent or a team colour.")
    banner_at: float = field(-100.0, unit="s")


def playing(ctx: Context) -> bool:
    """Run condition: the clock is running."""
    return ctx.get(Match).phase is Phase.PLAYING


def game_on(ctx: Context) -> bool:
    """Run condition: tonight's game isn't over (play, or a break between periods)."""
    return ctx.get(Match).phase is not Phase.OVER


@resource("run")
class Run:
    """A run up the ladder: one loss and it's over."""

    stage: int = field(0, doc="Index into the ladder.")
    perks: list[ContentRef[Perk]] = field([], doc="Every card taken, in order.")
    offers: list[ContentRef[Perk]] = field([], doc="Cards on the table in the locker room.")
    result: Result = field(Result.RUNNING)


@resource("career", keep="profile")
class Career:
    """Lifetime record, kept between runs."""

    titles: int = field(0)
    games_played: int = field(0)
    games_won: int = field(0)
    best_stage: int = field(0)
    points: int = field(0, doc="Your points over every finished run.")
    greens: int = field(0, doc="Your green releases over every finished run.")
