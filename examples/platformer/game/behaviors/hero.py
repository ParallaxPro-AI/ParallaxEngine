"""The hero: run, jump, double jump, dash."""

from parallax import Animator, Behavior, Vec3, behavior, on, param, state
from parallax.characters import Character, Jumped, Landed
from project import Assets

from game.audio import Sounds, play
from game.actions import Controls
from game.events import Respawned
from game.resources import alive


@behavior("hero_control", requires=[Character, Animator], when=alive)
class HeroControl(Behavior):
    """Turns intent into the Character controller: run left or right along the
    level's lane (the prefab's `lock_axes=["z"]` keeps it there). The controller supplies
    coyote time and the air jump (`air_jumps` in the prefab); this adds a jump
    buffer, so a press just before landing still jumps, and a dash along the
    facing direction that refills each time you land. Between a death and its
    respawn it takes no input (`when=alive`); the level stops it where it fell."""

    jump_buffer: float = param(0.15, unit="s")
    dash_speed: float = param(12, unit="m/s")
    dash_seconds: float = param(0.2, unit="s")

    buffer_left: float = state(0.0)
    dash_ready: bool = state(True)
    dash_left: float = state(0.0)
    facing: Vec3 = state(Vec3.RIGHT)

    def update(self, ctx, dt):
        character = self.entity.get(Character)
        run = ctx.input.value(Controls.run)
        if abs(run) > 0.15:
            self.facing = Vec3.RIGHT if run > 0 else Vec3.LEFT
        character.move(Vec3.RIGHT * run)
        self.jump(ctx, character, dt)
        self.dash(ctx, character, dt)
        self.animate(character)

    def jump(self, ctx, character, dt):
        if ctx.input.pressed(Controls.jump):
            self.buffer_left = self.jump_buffer
        if self.buffer_left > 0 and character.jump():
            self.buffer_left = 0.0
        self.buffer_left = max(0.0, self.buffer_left - dt)

    def dash(self, ctx, character, dt):
        self.dash_left = max(0.0, self.dash_left - dt)
        if not (ctx.input.pressed(Controls.dash) and self.dash_ready):
            return
        self.dash_ready = False
        self.dash_left = self.dash_seconds
        character.knockback(self.facing * self.dash_speed)
        ctx.vfx.play(Assets.vfx.dust, at=self.entity)

    def animate(self, character):
        """Feeds the animator graph (prefab), which plays the model's own Idle / Run /
        Jump_Idle clips."""
        animator = self.entity.get(Animator)
        animator.set_param("speed", character.velocity.flat().length())
        animator.set_param("grounded", character.grounded)
        animator.set_param("dashing", self.dash_left > 0)

    @on(Landed)
    def landed(self, ctx, event: Landed):
        self.dash_ready = True
        play(ctx, ctx.config(Sounds).land)

    @on(Jumped)
    def jumped(self, ctx, event: Jumped):
        play(ctx, ctx.config(Sounds).jump)

    @on(Respawned)
    def respawned(self, ctx, event: Respawned):
        character = self.entity.get(Character)
        character.stop()
        character.teleport(event.at)
        self.dash_ready, self.buffer_left = True, 0.0
