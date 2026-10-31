"""Game-wide state."""

from enum import Enum

from parallax import ContentRef, field, record, resource

from game.content import AmmoGrant, BotDef, UpgradeDef


class Phase(Enum):
    FIGHTING = "fighting"
    INTERMISSION = "intermission"
    WON = "won"
    LOST = "lost"


@record
class PendingBot:
    """A fragged bot waiting to come back (a deadline, so it survives a save)."""

    bot: ContentRef[BotDef]
    name: str
    at: float = field(unit="s")


@record
class CareerBests:
    score: int = field(0)
    frags: int = field(0)
    streak: int = field(0)
    rounds: int = field(0)


class FeedKind(Enum):
    KILL = "kill"
    ELITE = "elite"
    STREAK = "streak"
    BUFF = "buff"
    DEATH = "death"


@record
class FeedLine:
    """One line of the HUD's centre feed (bot down +points, streak shouts, upgrades, your
    own death), shown for `FEED_SECONDS` after `at`."""

    id: int
    text: str
    kind: FeedKind
    at: float = field(unit="s")
    points: int = field(0)
    multiplier: float = field(0)


@resource("match")
class Match:
    """The run: which round, frags toward its target, lives, score and streak."""

    phase: Phase = field(Phase.FIGHTING)
    round: int = field(0, doc="Index into the rounds, in order.")
    frags: int = field(0, doc="Frags this round.")
    lives: int = field(0)
    score: int = field(0)
    streak: int = field(0)
    best_streak: int = field(0)
    shots: int = field(0)
    hits: int = field(0)
    player_respawn_at: float = field(-1, unit="s", doc="-1 while alive.")
    bot_respawns: list[PendingBot] = field([])
    offer: list[ContentRef[UpgradeDef]] = field([])
    taken: list[ContentRef[UpgradeDef]] = field([], doc="Cards kept this run, in order.")
    lives_max: int = field(0)
    run_frags: int = field(0)
    deaths: int = field(0)
    started_at: float = field(0, unit="s")
    ended_at: float = field(-1, unit="s", doc="-1 while the run is on.")
    banner_at: float = field(-100, unit="s", doc="When the round-start banner went up.")
    feed: list[FeedLine] = field([])
    next_feed: int = field(1)
    best_before: CareerBests = field(CareerBests(), doc="The career bests as they stood when this run ended.")


@resource("scoreboard")
class Scoreboard:
    """Frags and deaths by fighter name, for the whole run."""

    frags: dict[str, int] = field({})
    deaths: dict[str, int] = field({})


@resource("mods")
class Mods:
    """Every upgrade card taken this run, folded together."""

    damage_dealt_mul: float = field(1)
    damage_taken_mul: float = field(1)
    bot_accuracy_mul: float = field(1)
    bot_health_mul: float = field(1)
    bot_respawn_add: float = field(0, unit="s")
    score_mul: float = field(1)
    armor_start: float = field(0)
    armor_on_kill: float = field(0)
    ammo_on_kill: list[AmmoGrant] = field([])
    streak_step_add: float = field(0)


@resource("career", keep="profile")
class Career:
    """Kept across runs: totals and the best single run."""

    runs: int = field(0)
    wins: int = field(0)
    frags: int = field(0)
    deaths: int = field(0)
    shots: int = field(0)
    hits: int = field(0)
    rounds: int = field(0, doc="Rounds cleared over every run.")
    best: CareerBests = field(CareerBests())

