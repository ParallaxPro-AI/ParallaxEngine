from parallax import Animator, Behavior, behavior, on, param
from parallax.characters import Character
from project import Assets

from game.components import Ball
from game.events import ShotReleased

CLIPS = Assets.clips


@behavior("baller_animation", requires=[Animator, Character])
class BallerAnimation(Behavior):
    """Idle or run from the body's speed (a dribble while you stand with the ball), and a
    jump shot on every release. The clips are the library's humanoid locomotion and
    sports clips, retargeted onto the baller model."""

    run_speed: float = param(0.5, unit="m/s", doc="Faster than this plays the run.")

    def update(self, ctx, dt):
        moving = self.entity.get(Character).velocity.flat().length() > self.run_speed
        _, ball = ctx.world.query(Ball).single()
        if moving:
            clip = CLIPS.run_cycle
        else:
            clip = CLIPS.ball_handle if ball.holder == self.entity else CLIPS.stand_idle
        self.entity.get(Animator).play(clip)

    @on(ShotReleased)
    def jump_shot(self, ctx, event):
        self.entity.get(Animator).play_once(CLIPS.jump_shot)
