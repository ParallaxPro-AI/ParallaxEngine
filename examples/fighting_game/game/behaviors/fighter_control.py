from parallax import Behavior, behavior, param, state
from project import Content

from game.actions import Controls
from game.components import Fighter, Intent
from game.fighters import buffer_attack


@behavior("fighter_control", requires=[Fighter, Intent])
class FighterControl(Behavior):
    """Turns the player's controls into intent. Down, forward, Light throws a Chi Bolt."""

    stick_threshold: float = param(0.45, min=0, max=1)
    motion_window: float = param(0.23, unit="s", doc="Time allowed from down to Light for the quarter-circle.")

    down_at: float = state(-10.0)
    forward_at: float = state(-10.0)
    was_up: bool = state(False)

    def update(self, ctx, dt):
        intent = self.entity.get(Intent)
        stick = ctx.input.axis(Controls.move)
        now = ctx.time.now
        up = stick.y > self.stick_threshold
        if stick.y < -self.stick_threshold:
            self.down_at = now
        if stick.x * self.entity.get(Fighter).facing > self.stick_threshold:
            self.forward_at = now

        intent.walk = stick.x
        intent.crouch = stick.y < -self.stick_threshold
        intent.guard = ctx.input.held(Controls.guard)
        intent.jump = intent.jump or (up and not self.was_up) or ctx.input.pressed(Controls.jump)
        self.was_up = up

        move = self.pressed_move(ctx, now)
        if move is not None:
            buffer_attack(ctx, intent, move)

    def pressed_move(self, ctx, now):
        if ctx.input.pressed(Controls.super):
            return Content.move.circuit_breaker
        if ctx.input.pressed(Controls.bolt):
            return Content.move.chi_bolt
        if ctx.input.pressed(Controls.heavy):
            return Content.move.heavy
        if ctx.input.pressed(Controls.light):
            quarter_circle = now - self.down_at < self.motion_window and self.forward_at >= self.down_at
            return Content.move.chi_bolt if quarter_circle else Content.move.jab
        return None
