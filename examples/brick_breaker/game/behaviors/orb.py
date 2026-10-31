import math
import random

from parallax import Behavior, Collided, Vec3, behavior, clamp, on, param, state, vec3
from parallax.combat import Health
from parallax.physics import Collider, Rigidbody

from game.actions import ServeControls
from game.components import Brick, Paddle, Rail
from game.events import BallLaunched, BallLost, BallReturned, RailHit, StageStarted
from game.progress import current_stage
from game.resources import Mods, Run


@behavior("orb", requires=[Rigidbody])
class Orb(Behavior):
    """The ball. Rests on the paddle until launched (or until the serve delay runs
    out), then travels at a constant speed that rises with every paddle return.
    Where it lands on the paddle steers it; bricks it touches take a hit. Falling
    past the open bottom edge loses it and puts it back on the paddle. The board is
    the x-z plane, and up the screen is +z (the engine is left-handed, +z forward)."""

    base_speed: float = param(9.0, unit="m/s")
    speed_step: float = param(0.25, unit="m/s", doc="Added on every paddle return.")
    max_speed: float = param(20.0, unit="m/s")
    serve_delay: float = param(2.2, unit="s", doc="Launches by itself after this long.")
    launch_spread: float = param(25, unit="deg", doc="Launch angle away from straight up the board.")
    english: float = param(3.2, unit="m/s", doc="Sideways kick from hitting the paddle's edge.")
    min_climb: float = param(0.32, min=0, max=1, doc="Smallest up-or-down share of the velocity.")
    rest_gap: float = param(0.66, unit="m", doc="How far up the board (+z) from the paddle it rests while serving.")
    lost_below: float = param(-7.7, unit="m", doc="Below this z the orb is gone.")

    speed: float = state(0.0)
    auto_launch_at: float = state(0.0)

    def start(self, ctx):
        self.serve(ctx)

    def update(self, ctx, dt):
        if ctx.get(Run).serving:
            self.wait_on_paddle(ctx)
        elif self.entity.transform.position.z < self.lost_below:
            ctx.emit(BallLost(at=self.entity.transform.position))
            self.serve(ctx)

    @on(StageStarted)
    def stage_started(self, ctx, event: StageStarted):
        self.serve(ctx)

    @on(Collided)
    def bounced(self, ctx, event: Collided):
        body = self.entity.get(Rigidbody)
        velocity = body.velocity
        other = event.target
        if other.has(Paddle):
            velocity = self.return_from(ctx, other, velocity)
        elif other.has(Brick):
            other.get(Health).damage(1, source=self.entity)
        elif other.has(Rail):
            ctx.emit(RailHit(at=self.entity.transform.position))
        body.velocity = self.steady(velocity)

    def serve(self, ctx):
        ctx.get(Run).serving = True
        self.auto_launch_at = ctx.time.now + self.serve_delay
        self.entity.get(Rigidbody).velocity = Vec3.ZERO

    def wait_on_paddle(self, ctx):
        paddle = ctx.world.query(tagged=Paddle).single().transform.position
        here = vec3(paddle.x, self.entity.transform.position.y, paddle.z + self.rest_gap)
        self.entity.get(Rigidbody).teleport(here)
        if ctx.input.pressed(ServeControls.launch) or ctx.time.now >= self.auto_launch_at:
            self.launch(ctx)

    def launch(self, ctx):
        scale = current_stage(ctx).ball_speed_scale
        self.speed = min(self.base_speed * scale * ctx.get(Mods).ball_slow, self.max_speed)
        side = random.choice((-1, 1))
        angle = math.radians(self.launch_spread)
        velocity = vec3(side * math.sin(angle), 0, math.cos(angle)) * self.speed
        self.entity.get(Rigidbody).velocity = velocity
        ctx.get(Run).serving = False
        ctx.emit(BallLaunched())

    def return_from(self, ctx, paddle, velocity: Vec3) -> Vec3:
        """Bounce back up the board, kicked sideways by how far from the paddle's
        centre it hit."""
        mods = ctx.get(Mods)
        half = paddle.get(Collider).size.x * paddle.transform.scale.x / 2
        offset = clamp((self.entity.transform.position.x - paddle.transform.position.x) / half, -1, 1)
        self.speed = min(self.speed + self.speed_step * mods.ball_accel, self.max_speed)
        ctx.emit(BallReturned(at=self.entity.transform.position))
        return vec3(velocity.x + offset * self.english * mods.english, 0, abs(velocity.z))

    def steady(self, velocity: Vec3) -> Vec3:
        """Rescale to the current speed, never letting the orb travel too flat."""
        direction = vec3(velocity.x, 0, velocity.z).normalized()
        if abs(direction.z) < self.min_climb:
            climb = self.min_climb if direction.z >= 0 else -self.min_climb
            across = (1 - climb * climb) ** 0.5
            direction = vec3(across if direction.x >= 0 else -across, 0, climb)
        return direction * self.speed
