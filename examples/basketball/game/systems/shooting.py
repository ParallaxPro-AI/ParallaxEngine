import random

from parallax import Context, Entity, System, clamp, on, system

from game.components import Ball, Bot, BoxScore, Edge, Flight, Throw, You
from game.content import CourtRules
from game.events import BucketIncoming, ShotReleased, Zone
from game.resources import Match
from game.rules import hoop_defended_by, nearest_opponent_distance, rival, team_of


@system("shooting")
class Shooting(System):
    """Decides a shot the moment it's released, then lets it fly.

    The make rate starts from where the meter stopped, then: the shooter's Edge
    (perks), the distance falloff, a hand in the face (THE decision in this game:
    shoot over it, or move the ball to the open man), and a bot's skill. The result
    rides on the ball's Flight and is revealed when it reaches the rim."""

    @on(ShotReleased)
    def release(self, ctx, event):
        ball_entity, ball = ctx.world.query(Ball).single()
        shooter = event.shooter
        if ball.holder != shooter or ball_entity.has(Flight):
            return
        court = ctx.config(CourtRules)
        rim = hoop_defended_by(ctx, rival(team_of(shooter)))
        distance = shooter.transform.position.flat().distance_to(rim.flat())
        points = court.three_points if distance >= court.three_point_distance else court.two_points
        contested = nearest_opponent_distance(ctx, shooter) <= court.contest_range
        made = random.random() < self.make_rate(ctx, shooter, event.zone, points, distance, contested)

        box = shooter.get(BoxScore)
        box.attempts += 1
        box.greens += 1 if event.zone is Zone.GREEN else 0
        assist = self.assist(ctx, ball) if made else None
        if made:
            box.made += 1
            box.points += points
        if assist is not None:
            assist.get(BoxScore).assists += 1

        ball.holder = None
        ball.passer = None
        ball.shot_clock = court.shot_clock
        ball_entity.add(Flight(
            kind=Throw.SHOT,
            thrower=shooter,
            start=ball_entity.transform.position,
            end=rim,
            duration=court.shot_flight_seconds,
            made=made,
            points=points,
            contested=contested,
            assist=assist,
        ))
        if made and self.clutch(ctx, contested):
            ctx.emit(BucketIncoming(shooter=shooter))

    def clutch(self, ctx: Context, contested: bool) -> bool:
        match, court = ctx.get(Match), ctx.config(CourtRules)
        final_period = match.overtime > 0 or match.quarter >= court.quarters
        close = abs(match.home_score - match.away_score) <= 6
        return contested or match.overtime > 0 or (final_period and close)

    def make_rate(self, ctx: Context, shooter: Entity, zone: Zone, points: int,
                  distance: float, contested: bool) -> float:
        court, edge = ctx.config(CourtRules), shooter.get(Edge)
        rate = {Zone.GREEN: court.green_rate, Zone.YELLOW: court.yellow_rate, Zone.MISS: court.miss_rate}[zone]
        rate += edge.make_bonus
        if points == court.three_points:
            rate += edge.three_bonus
        if ctx.get(Match).clock <= court.clutch_window:
            rate += edge.clutch_bonus

        if distance > court.max_shot_distance:
            rate *= court.min_rate
        elif distance > court.falloff_start:
            rate *= 1 - (distance - court.falloff_start) / (court.max_shot_distance - court.falloff_start)

        if contested:
            rate *= court.contest_penalty + edge.contest_relief
        if shooter.has(Bot):
            rate *= shooter.get(Bot).style.skill
        return clamp(rate, court.min_rate, court.your_max_rate if shooter.has(You) else court.bot_max_rate)

    def assist(self, ctx: Context, ball: Ball) -> Entity | None:
        """The passer, if this shot came off a pass caught moments ago."""
        fresh = ctx.time.now - ball.caught_at <= ctx.config(CourtRules).assist_window
        return ball.passer if fresh else None
