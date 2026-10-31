"""The runner: auto-run, three lanes, jump, slide, fast-fall, stumble."""

from parallax import Animator, Behavior, ClipRef, behavior, clamp, on, param, state, vec3

from game.audio import Sounds, play
from game.actions import Controls
from game.components import Runner
from game.config import Rules
from game.content import PowerUpEffect
from game.events import RunEnded, Stumbled
from game.resources import Run, buff, live


@behavior("surf_runner", requires=[Runner, Animator], when=live)
class SurfRunner(Behavior):
    """Runs down +z on its own, faster the longer it survives (and faster still
    in later districts or on the sprint board, whose model is its `board`
    child). Swipes change lane; jump is buffered; slide ducks overhead bars,
    and pressed in the air it slams down into a slide. A hit doesn't kill: it
    stumbles, bleeding speed for a moment. The guard is what ends the run.
    It stands still through the count-in and after the run ends (`when=live`)."""

    base_speed: float = param(14, unit="m/s")
    max_speed: float = param(32, unit="m/s")
    speed_gain: float = param(0.18, unit="m/s²")
    lane_switch_rate: float = param(16, doc="1/s; how hard it snaps to the lane centre.")
    jump_speed: float = param(11.5, unit="m/s")
    gravity: float = param(30, unit="m/s²")
    fast_fall_speed: float = param(28, unit="m/s")
    jump_buffer: float = param(0.14, unit="s")
    slide_seconds: float = param(0.72, unit="s")
    stumble_seconds: float = param(0.8, unit="s")
    stumble_speed_scale: float = param(0.55)
    recover_rate: float = param(3.0, doc="1/s; how quickly speed returns to target.")
    stumble_recover_rate: float = param(1.1, doc="1/s; slower while staggering, so a hit costs you.")
    lean_per_mps: float = param(1.6, unit="deg/(m/s)")
    max_lean: float = param(12, unit="deg")
    run_clip: ClipRef = param(doc="The model's own clips, by name.")
    jump_clip: ClipRef = param()
    slide_clip: ClipRef = param()
    stumble_clip: ClipRef = param()
    won_clip: ClipRef = param()
    caught_clip: ClipRef = param()

    run_time: float = state(0.0)
    velocity_y: float = state(0.0)
    buffer_left: float = state(0.0)
    slide_left: float = state(0.0)
    slide_on_landing: bool = state(False)
    stumble_left: float = state(0.0)

    def update(self, ctx, dt):
        runner = self.entity.get(Runner)
        sprint = buff(ctx, PowerUpEffect.SPRINT)
        self.entity.child("board").visible = sprint is not None
        self.run_time += dt
        self.stumble_left = max(0.0, self.stumble_left - dt)
        self.steer(ctx, runner)
        self.accelerate(ctx, runner, sprint.power if sprint else None, dt)
        self.jump_and_slide(ctx, runner, dt)
        self.move(ctx, runner, dt)

    def steer(self, ctx, runner):
        lanes = len(ctx.config(Rules).lane_xs)
        step = int(ctx.input.pressed(Controls.right)) - int(ctx.input.pressed(Controls.left))
        if step and 0 <= runner.lane + step < lanes:
            runner.lane += step
            ctx.get(Run).learned_lane = True
            play(ctx, ctx.config(Sounds).whoosh)

    def accelerate(self, ctx, runner, sprint_scale: float | None, dt):
        district = ctx.get(Run).district.data
        top = self.max_speed * district.speed_scale * (sprint_scale or 1)
        if sprint_scale:
            target = top
        else:
            target = min(top, (self.base_speed + self.speed_gain * self.run_time) * district.speed_scale)
        rate = self.stumble_recover_rate if self.stumble_left > 0 else self.recover_rate
        runner.speed += (target - runner.speed) * min(1.0, rate * dt)

    def jump_and_slide(self, ctx, runner, dt):
        animator = self.entity.get(Animator)
        grounded = self.entity.transform.position.y <= 0 and self.velocity_y <= 0
        self.buffer_left = self.jump_buffer if ctx.input.pressed(Controls.jump) else max(0.0, self.buffer_left - dt)
        if self.buffer_left > 0 and grounded and not runner.sliding:
            self.buffer_left, self.velocity_y = 0.0, self.jump_speed
            ctx.get(Run).learned_jump = True
            animator.play_once(self.jump_clip)
            play(ctx, ctx.config(Sounds).jump)
        if ctx.input.pressed(Controls.slide):
            ctx.get(Run).learned_slide = True
            if grounded:
                self.slide(ctx, runner)
            else:
                self.velocity_y = min(self.velocity_y, -self.fast_fall_speed)
                self.slide_on_landing = True
        self.slide_left = max(0.0, self.slide_left - dt)
        runner.sliding = self.slide_left > 0
        if grounded and not runner.sliding and self.stumble_left <= 0:
            animator.play(self.run_clip)

    def slide(self, ctx, runner):
        self.slide_left = self.slide_seconds
        runner.sliding = True
        self.entity.get(Animator).play_once(self.slide_clip)
        play(ctx, ctx.config(Sounds).slide)

    def move(self, ctx, runner, dt):
        transform = self.entity.transform
        here = transform.position
        lateral = (ctx.config(Rules).lane_xs[runner.lane] - here.x) * self.lane_switch_rate
        self.velocity_y -= self.gravity * dt
        y = here.y + self.velocity_y * dt
        if y <= 0:
            y, self.velocity_y = 0.0, 0.0
            if self.slide_on_landing:
                self.slide_on_landing = False
                self.slide_left = self.slide_seconds
        transform.position = vec3(here.x + lateral * dt, y, here.z + runner.speed * dt)
        transform.euler = vec3(0, 0, clamp(-lateral * self.lean_per_mps, -self.max_lean, self.max_lean))

    @on(Stumbled)
    def stumbled(self, ctx, event: Stumbled):
        runner = self.entity.get(Runner)
        self.stumble_left = self.stumble_seconds
        self.run_time *= 0.5
        runner.speed = max(self.base_speed, runner.speed) * self.stumble_speed_scale
        self.slide_left = 0.0
        self.entity.get(Animator).play_once(self.stumble_clip)

    @on(RunEnded)
    def ended(self, ctx, event: RunEnded):
        self.entity.get(Animator).play(self.won_clip if event.won else self.caught_clip, loop=event.won)
