"""The courier: hop, duck, fast-fall, and the poses that show which."""

from parallax import Behavior, Sprite, behavior, on, param, state, vec2
from parallax.combat import Damaged, Health
from parallax.physics import Collider
from project import Assets

from game.actions import Controls
from game.components import Hopper
from game.config import Canyon, Sounds
from game.resources import Profile, running

# The courier is the template's animated sprite (prefabs/runner.prefab.json): one
# animation per pose, the whole sprite tinted by the equipped outfit.


@behavior("runner_motion", requires=[Hopper, Collider, Health], when=running)
class RunnerMotion(Behavior):
    """Flies the runner's hop on its own deterministic gravity (no rigidbody), so
    a hop's airtime is exact and the hazard feeder can size every gap against it.

    A hop pressed just before landing is buffered. Holding duck on the ground is
    a slide (a shorter hitbox); holding it in the air is a fast-fall. The courier
    plays the template's animation for each (run cycle, hop, slide, hurt), wears
    the equipped outfit's tint, and it blinks while `Health` keeps it invulnerable
    after a hit. When the run ends the courier freezes mid-stride for the end beat."""

    hurt_pose_seconds: float = param(0.35, unit="s")
    blink_rate: float = param(12, unit="Hz")

    velocity_y: float = state(0.0)
    grounded: bool = state(True)
    buffer_left: float = state(0.0)
    hurt_until: float = state(0.0)

    def update(self, ctx, dt):
        hopper = self.entity.get(Hopper)
        ducking = ctx.input.held(Controls.duck)

        if ctx.input.pressed(Controls.hop):
            self.buffer_left = hopper.jump_buffer
        self.buffer_left = max(0.0, self.buffer_left - dt)
        if self.buffer_left > 0 and self.grounded:
            self.hop(ctx, hopper)

        self.fall(ctx, hopper, ducking, dt)
        self.fit_hitbox(hopper, sliding=ducking and self.grounded)
        self.show(ctx, ducking, dt)

    def hop(self, ctx, hopper):
        self.buffer_left = 0.0
        self.velocity_y = hopper.hop_speed
        self.grounded = False
        ctx.audio.play(ctx.config(Sounds).hop)
        ctx.vfx.play(Assets.vfx.dust, at=self.feet())

    def fall(self, ctx, hopper, ducking, dt):
        gravity = hopper.gravity * (hopper.fast_fall_scale if ducking and not self.grounded else 1)
        self.velocity_y = max(self.velocity_y - gravity * dt, -hopper.max_fall)
        rest_y = ctx.config(Canyon).ground_y + hopper.height / 2
        transform = self.entity.transform
        y = transform.position.y + self.velocity_y * dt
        if y <= rest_y:
            if not self.grounded:
                ctx.vfx.play(Assets.vfx.dust, at=self.feet())
            y, self.velocity_y, self.grounded = rest_y, 0.0, True
        else:
            self.grounded = False
        transform.position = transform.position.with_y(y)

    def feet(self):
        return self.entity.transform.position - vec2(0, self.entity.get(Hopper).height / 2).to_vec3()

    def fit_hitbox(self, hopper, sliding):
        """A slide shrinks the box from the top; the feet stay on the ground.
        In the air the box stays full size, so tucking can't skip a hop."""
        collider = self.entity.get(Collider)
        height = (hopper.duck_height if sliding else hopper.height) * hopper.hitbox_scale
        collider.size = collider.size.with_y(height)
        collider.offset = collider.offset.with_y((height - hopper.height * hopper.hitbox_scale) / 2)

    def show(self, ctx, ducking, dt):
        if ctx.time.now < self.hurt_until:
            pose = "hurt"
        elif not self.grounded:
            pose = "hop"
        else:
            pose = "duck" if ducking else "run"
        sprite = self.entity.get(Sprite)
        sprite.play(pose)
        blinking = self.entity.get(Health).invulnerable and int(ctx.time.now * self.blink_rate) % 2 == 0
        sprite.color = ctx.get(Profile).outfit.data.tint.with_alpha(0.4 if blinking else 1.0)

    @on(Damaged)
    def hurt(self, ctx, event: Damaged):
        self.hurt_until = ctx.time.now + self.hurt_pose_seconds
