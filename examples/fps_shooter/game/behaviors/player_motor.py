from parallax import Behavior, Vec3, behavior, param, state
from parallax.characters import Character
from parallax.combat import Health

from project import Assets

from game.actions import FpsControls


@behavior("player_motor", requires=[Character, Health])
class PlayerMotor(Behavior):
    """Movement relative to the view: WASD moves, Shift sprints, Space jumps, C toggles
    crouch. The first-person camera rig turns the body with the mouse. Boots sound every
    `stride` meters walked on the ground (the template's synthesized foley)."""

    stride: float = param(2.1, unit="m")

    walked: float = state(0.0)
    last_at: Vec3 = state(Vec3.ZERO)

    def update(self, ctx, dt):
        body = self.entity.get(Character)
        if self.entity.get(Health).dead:
            body.stop()
            return
        stick = ctx.input.axis(FpsControls.move)
        body.move(ctx.camera.main.relative(stick), run=ctx.input.held(FpsControls.sprint))
        if ctx.input.pressed(FpsControls.jump):
            body.jump()
        if ctx.input.pressed(FpsControls.crouch):
            body.set_stance("stand" if body.stance == "crouch" else "crouch")
        self.footsteps(ctx, body)

    def footsteps(self, ctx, body):
        here = self.entity.transform.position
        step = Vec3(here.x - self.last_at.x, 0, here.z - self.last_at.z).length()
        self.last_at = here
        if step > 2 or not body.grounded:  # a respawn teleport, or airborne
            self.walked = 0.0 if step > 2 else self.walked
            return
        self.walked += step
        if self.walked >= self.stride:
            self.walked = 0.0
            ctx.audio.play(Assets.sfx.dm_step)
