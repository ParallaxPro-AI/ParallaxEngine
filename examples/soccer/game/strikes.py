"""The one way anyone kicks the ball: the human, the AI strikers and the keepers."""

from parallax import Context, Entity, Vec3
from parallax.physics import Rigidbody

from game.components import Ball
from game.events import BallStruck, Strike


def strike(ctx: Context, ball_entity: Entity, by: Entity, velocity: Vec3, kind: Strike) -> None:
    """Send the ball off at `velocity`. It leaves the striker's feet and is loose
    until someone wins it, and nobody can touch it for the ball's strike cooldown."""
    ball = ball_entity.get(Ball)
    ball.holder = None
    ball.kick_cooldown = ball.strike_cooldown
    ball_entity.get(Rigidbody).velocity = velocity
    ctx.emit(BallStruck(by=by, kind=kind))
