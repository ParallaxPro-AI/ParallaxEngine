from parallax import Context, Entity, System, system

from game.components import Ball, BoxScore, Edge, Flight
from game.content import CourtRules
from game.events import ReboundClaimed
from game.resources import playing
from game.rules import give_ball


@system("rebounds", when=playing)
class Rebounds(System):
    """The loose-ball scramble. The first body to reach the ball takes it; if nobody
    does in time, the closest one is given it so play never stalls."""

    def update(self, ctx, dt):
        ball_entity, ball = ctx.world.query(Ball).single()
        if ball.holder is not None or ball_entity.has(Flight):
            return
        ball.loose_for -= dt
        ball.boxed_out_for = max(0.0, ball.boxed_out_for - dt)
        pickup_radius = ctx.config(CourtRules).pickup_radius
        contenders = (ctx.world.query(BoxScore, Edge)
                      .where(lambda player, box, edge: not (player == ball.boxed_out and ball.boxed_out_for > 0))
                      .by_distance(ball.rest))
        for player, _, edge in contenders:
            if player.transform.position.flat().distance_to(ball.rest) <= pickup_radius + edge.pickup_radius:
                self.claim(ctx, player)
                return
        if ball.loose_for <= 0:
            nearest, _, _ = contenders[0]
            self.claim(ctx, nearest)

    def claim(self, ctx: Context, player: Entity) -> None:
        give_ball(ctx, player)
        player.get(BoxScore).rebounds += 1
        ctx.emit(ReboundClaimed(by=player))
