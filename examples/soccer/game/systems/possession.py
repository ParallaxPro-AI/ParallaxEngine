from parallax import Context, System, Vec3, system
from parallax.physics import Rigidbody

from game.components import Ball, Footballer
from game.events import PossessionWon
from game.resources import playing
from game.rules import team_of


@system("possession", when=playing)
class Possession(System):
    """Who has the ball, and the one place possession changes hands.

    The nearest player within dribble range wins the ball, unless a teammate of the
    holder is nearer or possession changed hands less than `tackle_lock` ago. Both
    rules matter: without them two players standing over the ball trade it every
    frame. The holder keeps the ball on a spring just ahead of their feet, and loses
    it by running away from it."""

    def fixed_update(self, ctx, dt):
        ball_entity, ball, body = ctx.world.query(Ball, Rigidbody).single()
        ball.possession_lock = max(0.0, ball.possession_lock - dt)
        ball.kick_cooldown = max(0.0, ball.kick_cooldown - dt)
        at = ball_entity.transform.position

        if ball.holder is not None and ball.holder.transform.position.distance_to(at) >= ball.dribble_range:
            ball.holder = None
        if ball.kick_cooldown == 0 and ball.possession_lock == 0:
            self.challenge(ctx, ball, at)
        if ball.holder is not None:
            feet = ball.holder.transform
            carry_spot = feet.position + feet.forward.flat().normalized() * ball.carry_ahead
            body.velocity += (carry_spot - at).flat() * ball.carry_pull * dt

    def challenge(self, ctx: Context, ball: Ball, at: Vec3) -> None:
        nearest = ctx.world.query(Footballer).near(at, ball.dribble_range).nearest(at)
        if nearest is None:
            return
        player, _ = nearest
        previous = ball.holder
        if previous is not None and team_of(player) is team_of(previous):
            return
        ball.holder = player
        ball.possession_lock = ball.tackle_lock
        ctx.emit(PossessionWon(by=player, previous=previous))
