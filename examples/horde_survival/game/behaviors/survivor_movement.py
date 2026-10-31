from parallax import Animator, Behavior, behavior, param
from parallax.characters import Character
from project import Assets

from game.actions import Controls


@behavior("survivor_movement", requires=[Character, Animator])
class SurvivorMovement(Behavior):
    """Steers the survivor relative to the camera: walking, running while Shift is held,
    standing otherwise. Speed upgrades change `Character.walk_speed` itself
    (game/effects.py), so nothing is copied here."""

    moving_speed: float = param(0.05, unit="m/s", doc="Faster than this plays a gait.")

    def update(self, ctx, dt):
        body = self.entity.get(Character)
        body.move(ctx.camera.main.relative(ctx.input.axis(Controls.move)))
        if body.velocity.flat().length() <= self.moving_speed:
            clip = Assets.clips.stand_idle
        elif ctx.input.held(Controls.dash):
            clip = Assets.clips.run_cycle
        else:
            clip = Assets.clips.walk_cycle
        self.entity.get(Animator).play(clip)
