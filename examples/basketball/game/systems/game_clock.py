from parallax import Context, System, system

from game.components import Away, Ball, Home
from game.content import CourtRules
from game.events import GameDecided, PeriodEnded, PeriodStarted, ShotClockExpired
from game.resources import Match, Phase, game_on
from game.rules import team_of


@system("game_clock", when=game_on)
class GameClock(System):
    """The game clock and the shot clock.

    Every period starts from a break: the tip-off is a break that is already over.
    Quarters alternate who takes the ball out. Tied at the final buzzer, it adds an
    overtime period, and another, until someone leads: a ladder game never ends in
    a draw. Holding the ball for a full shot clock is a turnover."""

    def update(self, ctx, dt):
        match = ctx.get(Match)
        if match.phase is Phase.BREAK:
            match.break_left -= dt
            if match.break_left <= 0:
                self.start_period(ctx, match, ctx.config(CourtRules).quarter_seconds)
            return

        _, ball = ctx.world.query(Ball).single()
        if ball.holder is not None:
            ball.shot_clock -= dt
            if ball.shot_clock <= 0:
                ctx.emit(ShotClockExpired(team=team_of(ball.holder)))

        match.clock -= dt
        if match.clock <= 0:
            self.buzzer(ctx, match)

    def buzzer(self, ctx: Context, match: Match) -> None:
        court = ctx.config(CourtRules)
        ctx.emit(PeriodEnded(quarter=match.quarter))
        if match.quarter < court.quarters:
            match.phase = Phase.BREAK
            match.break_left = court.intermission_seconds
        elif match.home_score == match.away_score:
            match.overtime += 1
            self.start_period(ctx, match, court.overtime_seconds)
        else:
            match.phase = Phase.OVER
            ctx.emit(GameDecided(won=match.home_score > match.away_score))

    def start_period(self, ctx: Context, match: Match, seconds: float) -> None:
        match.phase = Phase.PLAYING
        match.quarter += 1
        match.clock = seconds
        ctx.emit(PeriodStarted(quarter=match.quarter, inbound=Away if match.quarter % 2 == 0 else Home))
