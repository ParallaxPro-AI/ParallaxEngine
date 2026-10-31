from parallax import Behavior, Context, Vec2, behavior, param, state
from parallax.characters import Character

from game.actions import Controls
from game.components import Ball, Edge, Meter, Stamina
from game.content import CourtRules
from game.events import PassAttempted, StealAttempted
from game.resources import playing


@behavior("human_baller", requires=[Character, Edge, Meter, Stamina], when=playing)
class HumanBaller(Behavior):
    """Your legs and hands: run, sprint on a stamina tank, pass, reach in for steals.

    You slow down a little with the ball and plant your feet while the shot meter
    charges. A steal attempt goes on cooldown whether or not it works, so mashing
    the button costs something. Perks reach this behavior through the fields it
    reads (speeds, tank, steal cooldown), so it never asks which perks you hold."""

    handle_pace: float = param(0.85, min=0, max=1, doc="Speed while dribbling.")
    steal_ready_at: float = state(0.0, doc="Game time the steal button is live again.")

    def update(self, ctx, dt):
        _, ball = ctx.world.query(Ball).single()
        has_ball = ball.holder == self.entity
        self.run(ctx, dt, has_ball)

        if has_ball and ctx.input.pressed(Controls.pass_ball):
            ctx.emit(PassAttempted(passer=self.entity))
        if ctx.input.pressed(Controls.steal) and ctx.time.now >= self.steal_ready_at:
            court = ctx.config(CourtRules)
            cooldown = court.steal_cooldown + self.entity.get(Edge).steal_cooldown
            self.steal_ready_at = ctx.time.now + max(court.min_steal_cooldown, cooldown)
            ctx.emit(StealAttempted(by=self.entity))

    def run(self, ctx: Context, dt: float, has_ball: bool) -> None:
        character, stamina = self.entity.get(Character), self.entity.get(Stamina)
        planted = self.entity.get(Meter).charging
        stick = Vec2.ZERO if planted else ctx.input.axis(Controls.move)
        moving = stick.length() > 0
        sprinting = moving and ctx.input.held(Controls.sprint) and stamina.current > stamina.max * stamina.floor
        if sprinting:
            stamina.current = max(0.0, stamina.current - stamina.drain * dt)
        else:
            stamina.current = min(stamina.max, stamina.current + stamina.regen * dt)

        speed = character.run_speed if sprinting else character.walk_speed
        if has_ball:
            speed *= self.handle_pace
        character.move(ctx.camera.main.relative(stick), speed=speed * min(1.0, stick.length()))
