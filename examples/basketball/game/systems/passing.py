from parallax import System, on, system

from game.components import Ball, Flight, Throw
from game.content import CourtRules, Sounds
from game.events import PassAttempted
from game.rules import team_of, teammates


@system("passing")
class Passing(System):
    """Throws a pass to the passer's teammate if he's in range. It's 2v2, so there
    is only ever one man to throw to: the decision is *whether* to pass."""

    @on(PassAttempted)
    def throw(self, ctx, event):
        ball_entity, ball = ctx.world.query(Ball).single()
        if ball.holder != event.passer or ball_entity.has(Flight):
            return
        start = event.passer.transform.position
        receiver = next(p for p in teammates(ctx, team_of(event.passer)) if p != event.passer)
        distance = start.distance_to(receiver.transform.position)
        if distance > ctx.config(CourtRules).pass_range:
            return
        ball.holder = None
        ball_entity.add(Flight(
            kind=Throw.PASS,
            thrower=event.passer,
            receiver=receiver,
            start=ball_entity.transform.position,
            end=receiver.transform.position,
            duration=distance / ball.pass_speed,
        ))
        ctx.audio.play(ctx.config(Sounds).pass_ball, at=event.passer)
