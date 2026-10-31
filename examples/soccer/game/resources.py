"""Game-wide state: the tie being played, the cup run around it, and the career record."""

from enum import Enum

from parallax import ContentRef, Context, Entity, field, resource

from game.content import TrainingCard


class Phase(Enum):
    KICKOFF = "kickoff"     # everyone on their slot, counting down
    PLAYING = "playing"
    GOAL = "goal"           # the celebration before the restart
    BREAK = "break"         # half time, or the beat before golden goal
    DECIDED = "decided"     # the tie is over


class Result(Enum):
    UNDECIDED = "undecided"
    CHAMPIONS = "champions"
    KNOCKED_OUT = "knocked_out"


@resource("match")
class Match:
    """The tie on the pitch right now. Reset at the start of every tie."""

    phase: Phase = field(Phase.KICKOFF)
    phase_left: float = field(0, unit="s", doc="Countdown of every phase except PLAYING.")
    half: int = field(1)
    clock: float = field(0, unit="s", doc="Time left in the half, or in golden goal.")
    golden: bool = field(False)
    home_goals: int = field(0)
    away_goals: int = field(0)
    controlled: Entity | None = field(None, doc="The home player taking your input.")


def playing(ctx: Context) -> bool:
    """The run condition of everything that only acts while the ball is live."""
    return ctx.get(Match).phase is Phase.PLAYING


@resource("cup")
class Cup:
    """One run at the cup: the round, the training picked so far, and the stats sheet."""

    round: int = field(0, doc="Index into the cup's rounds.")
    training: list[ContentRef[TrainingCard]] = field([], doc="Every card picked, in order.")
    offers: list[ContentRef[TrainingCard]] = field([], doc="Cards on the table at the team talk.")
    result: Result = field(Result.UNDECIDED)
    shots: int = field(0)
    saves: int = field(0)
    turnovers: int = field(0)


@resource("career", keep="profile")
class Career:
    """Lifetime record, kept between runs."""

    cups_won: int = field(0)
    ties_played: int = field(0)
    ties_won: int = field(0)
    goals_for: int = field(0)
    goals_against: int = field(0)
    best_round: int = field(0)
