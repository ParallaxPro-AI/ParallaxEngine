from parallax import Context, System, Tag, on, system, vec3
from parallax.characters import Character

from game.components import Ball, Flight, Home
from game.content import CourtRules
from game.events import BucketScored, PeriodStarted, ShotClockExpired
from game.rules import give_ball, hoop_defended_by, rival, team_of, teammates, you


@system("restarts")
class Restarts(System):
    """Street-ball "take it back". After a bucket, a shot-clock turnover or a new
    period, the team taking the ball out lines up deep at its own end and the other
    team is already partway back on defense. Without the reset, a made basket left
    everyone under the wrong rim and the next possession was a free run-out."""

    @on(BucketScored)
    def after_bucket(self, ctx, event):
        self.take_it_back(ctx, rival(team_of(event.shooter)))

    @on(ShotClockExpired)
    def after_violation(self, ctx, event):
        self.take_it_back(ctx, rival(event.team))

    @on(PeriodStarted)
    def new_period(self, ctx, event):
        self.take_it_back(ctx, event.inbound)

    def take_it_back(self, ctx: Context, inbound: Tag) -> None:
        court = ctx.config(CourtRules)
        for team in (inbound, rival(inbound)):
            rim = hoop_defended_by(ctx, team)
            toward_centre = -1 if rim.x > 0 else 1
            depth = court.inbound_start if team is inbound else court.defense_reset
            for lane, player in enumerate(teammates(ctx, team)):
                spot = vec3(rim.x + toward_centre * depth, 0, (lane - 1) * court.lane_spacing)
                player.get(Character).teleport(spot)
        ball_entity, _ = ctx.world.query(Ball).single()
        if ball_entity.has(Flight):
            ball_entity.remove(Flight)
        give_ball(ctx, you(ctx) if inbound is Home else teammates(ctx, inbound)[0])
