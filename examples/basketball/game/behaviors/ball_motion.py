import math

from parallax import Behavior, Transform, Vec3, behavior, param, vec3

from game.components import Ball, Flight, Throw


@behavior("ball_motion", requires=[Ball])
class BallMotion(Behavior):
    """Puts the ball where the rules say it is: dribbled at the holder's hand, arcing
    through a pass or shot, or bouncing loose where a miss landed. Pure presentation;
    possession never depends on where this draws it."""

    hand: Vec3 = param(vec3(0.4, 1.1, 0.3), unit="m", doc="Dribbling hand, in the holder's local space.")
    floor: float = param(0.28, unit="m", doc="Height of the ball's centre when it touches the floor.")
    dribble_rate: float = param(8.5, doc="Dribble bounce speed.")
    loose_rate: float = param(5.5, doc="Loose-ball bounce speed.")
    loose_bounce: float = param(0.5, unit="m")
    shot_arc: float = param(4.5, unit="m", doc="Minimum height of a shot's arc...")
    shot_arc_per_meter: float = param(0.18, doc="...plus this per meter of distance.")
    pass_arc: float = param(2.5, unit="m")
    pass_arc_per_meter: float = param(0.1)

    def late_update(self, ctx, dt):
        ball = self.entity.get(Ball)
        flight = self.entity.try_get(Flight)
        if flight is not None:
            position = self.arc(flight)
        elif ball.holder is not None:
            position = self.dribble(ball.holder.transform, ctx.time.now)
        else:
            position = ball.rest.with_y(self.floor + abs(math.sin(ctx.time.now * self.loose_rate)) * self.loose_bounce)
        self.entity.transform.position = position

    def arc(self, flight: Flight) -> Vec3:
        t = min(1.0, flight.elapsed / flight.duration)
        distance = flight.start.distance_to(flight.end)
        if flight.kind is Throw.SHOT:
            peak = max(self.shot_arc, distance * self.shot_arc_per_meter)
        else:
            peak = max(self.pass_arc, distance * self.pass_arc_per_meter)
        return flight.start.lerp(flight.end, t) + Vec3.UP * (4 * peak * t * (1 - t))

    def dribble(self, holder: Transform, now: float) -> Vec3:
        hand = holder.to_world(self.hand)
        bounce = abs(math.sin(now * self.dribble_rate))
        return hand.with_y(self.floor + (hand.y - self.floor) * bounce)
