import random

from parallax import Behavior, Collided, behavior, clamp, on, param, state, vec3
from parallax.physics import Rigidbody

from game.components import Paddle, Smash, Wall
from game.events import BallReturned, BallServed, DuelStarted, RallyEnded, WallHit
from game.progress import current_rival
from game.resources import Duel, Mods


@behavior("volley_ball", requires=[Rigidbody])
class VolleyBall(Behavior):
    """The ball. Waits on the centre spot, then serves toward a random side. Every
    return speeds it up and bends it by where it met the paddle; a loaded smash
    sends it back much faster. Walls bounce it through physics. The court is the
    x-z plane: x runs goal to goal, z along the paddles."""

    base_speed: float = param(8.0, unit="m/s")
    speed_step: float = param(0.45, unit="m/s", doc="Added on every return.")
    max_speed: float = param(22.0, unit="m/s")
    smash_cap: float = param(1.4, doc="A smash may exceed max_speed by this factor.")
    serve_delay: float = param(1.2, unit="s")
    serve_spread: float = param(0.5, min=0, max=1, doc="Largest along-the-paddle share of a serve.")
    english: float = param(1.6, doc="Along-the-paddle speed added per metre off the paddle's centre.")
    max_slope: float = param(0.85, min=0, max=1, doc="Along-the-paddle speed cap as a share of speed.")

    serve_at: float = state(0.0)

    def start(self, ctx):
        self.reset(ctx)

    def update(self, ctx, dt):
        if ctx.get(Duel).serving and ctx.time.now >= self.serve_at:
            self.launch(ctx)

    @on(DuelStarted)
    def duel_started(self, ctx, event: DuelStarted):
        self.reset(ctx)

    @on(RallyEnded)
    def rally_ended(self, ctx, event: RallyEnded):
        self.reset(ctx)

    @on(Collided)
    def bounced(self, ctx, event: Collided):
        if event.target.has(Paddle):
            self.return_from(ctx, event.target)
        elif event.target.has(Wall):
            ctx.emit(WallHit(at=self.entity.transform.position))

    def reset(self, ctx):
        """Back to the centre spot, at rest, serving after the delay."""
        ctx.get(Duel).serving = True
        self.serve_at = ctx.time.now + self.serve_delay
        height = self.entity.transform.position.y
        self.entity.get(Rigidbody).teleport(vec3(0, height, 0))

    def launch(self, ctx):
        speed = self.base_speed * current_rival(ctx).ball_speed_scale
        across = random.choice((-1, 1)) * speed
        along = random.uniform(-1, 1) * speed * self.serve_spread
        self.entity.get(Rigidbody).velocity = vec3(across, 0, along)
        ctx.get(Duel).serving = False
        ctx.emit(BallServed())

    def return_from(self, ctx, paddle):
        """Send the ball back across the court, faster and bent by the contact point."""
        mods = ctx.get(Mods)
        body = self.entity.get(Rigidbody)
        speed = min(abs(body.velocity.x) + self.speed_step * mods.ball_accel, self.max_speed)
        english = self.english
        smashed = False

        smash = paddle.try_get(Smash)
        if smash:  # only the player's paddle smashes, and only it gets the run's perks
            english *= mods.english
            speed *= mods.return_speed
            if smash.charge >= smash.threshold:
                boost = 1 + smash.charge * smash.boost * mods.charge_boost
                speed = min(speed * boost, self.max_speed * self.smash_cap)
                smashed = True
            smash.charge = 0.0

        here = self.entity.transform.position
        away = 1 if here.x > paddle.transform.position.x else -1
        bend = (here.z - paddle.transform.position.z) * english
        limit = speed * self.max_slope
        body.velocity = vec3(away * speed, 0, clamp(body.velocity.z + bend, -limit, limit))
        ctx.emit(BallReturned(source=paddle, smashed=smashed))
