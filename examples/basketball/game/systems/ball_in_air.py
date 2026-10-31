import random

from parallax import Context, System, clamp, system, vec3

from game.components import Ball, Flight, Home, Throw, You
from game.content import CourtRules
from game.events import BucketScored, ShotMissed
from game.resources import Match, game_on
from game.rules import give_ball, team_of


@system("ball_in_air", when=game_on)
class BallInAir(System):
    """Lands passes and shots. A pass is caught; a made shot scores; a miss caroms
    LOOSE, kicked out toward mid-court so the offense doesn't just tip in its own
    miss, and the bot that missed is boxed out of its own rebound for a beat."""

    def update(self, ctx, dt):
        for ball_entity, ball, flight in ctx.world.query(Ball, Flight):
            flight.elapsed += dt
            if flight.elapsed < flight.duration:
                continue
            ball_entity.remove(Flight)
            if flight.kind is Throw.PASS:
                give_ball(ctx, flight.receiver)
                ball.passer = flight.thrower
                ball.caught_at = ctx.time.now
            elif flight.made:
                self.score(ctx, flight)
            else:
                self.carom(ctx, ball, flight)

    def score(self, ctx: Context, flight: Flight) -> None:
        match = ctx.get(Match)
        if team_of(flight.thrower) is Home:
            match.home_score += flight.points
        else:
            match.away_score += flight.points
        ctx.emit(BucketScored(shooter=flight.thrower, points=flight.points,
                              assist=flight.assist, contested=flight.contested))

    def carom(self, ctx: Context, ball: Ball, flight: Flight) -> None:
        court = ctx.config(CourtRules)
        rim = flight.end
        toward_centre = -1 if rim.x > 0 else 1
        spread = court.rebound_spread
        ball.rest = vec3(
            clamp(rim.x + toward_centre * court.rebound_out_bias + random.uniform(-spread, spread),
                  -court.court_half_length, court.court_half_length),
            0,
            clamp(rim.z + random.uniform(-spread, spread), -court.court_half_width, court.court_half_width),
        )
        ball.loose_for = court.loose_ball_seconds
        shooter = flight.thrower
        ball.boxed_out = None if shooter.has(You) else shooter
        ball.boxed_out_for = court.shooter_box_out
        ctx.emit(ShotMissed(shooter=shooter))
