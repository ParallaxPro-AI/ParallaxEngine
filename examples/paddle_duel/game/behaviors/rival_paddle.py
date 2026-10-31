import random

from parallax import Behavior, behavior, clamp, move_toward, param, state
from parallax.physics import Rigidbody

from game.components import Ball
from game.progress import current_rival


@behavior("rival_paddle")
class RivalPaddle(Behavior):
    """Plays the current rival. It re-reads the ball every reaction time and guesses
    wrong by up to its aim error, leads the ball by its prediction, and drifts back
    to the centre while the ball is heading away. Beating it takes angles and
    smashes, not out-running it."""

    reach: float = param(5.5, unit="m")
    dead_zone: float = param(0.25, unit="m", doc="Close enough: the paddle stops here.")
    lead_time: float = param(0.35, unit="s", doc="Look-ahead at full prediction.")

    aim_offset: float = state(0.0)
    next_read_at: float = state(0.0)

    def update(self, ctx, dt):
        rival = current_rival(ctx)
        if ctx.time.now >= self.next_read_at:
            self.next_read_at = ctx.time.now + rival.reaction_time
            self.aim_offset = random.uniform(-rival.aim_error, rival.aim_error)

        tf = self.entity.transform
        target = self.target(ctx, rival.predict)
        if abs(target - tf.position.z) > self.dead_zone:
            tf.position = tf.position.with_z(move_toward(tf.position.z, target, rival.speed * dt))

    def target(self, ctx, predict: float) -> float:
        ball = ctx.world.query(tagged=Ball).single()
        velocity = ball.get(Rigidbody).velocity
        incoming = velocity.x * (self.entity.transform.position.x - ball.transform.position.x) > 0
        if not incoming:
            return 0.0
        guess = ball.transform.position.z + velocity.z * predict * self.lead_time + self.aim_offset
        return clamp(guess, -self.reach, self.reach)
