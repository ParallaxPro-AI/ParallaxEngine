import random

from parallax import System, on, system

from game.components import Ball, Bot, BoxScore, Edge, Flight
from game.content import CourtRules
from game.events import BallStolen, StealAttempted
from game.rules import give_ball, team_of


@system("defense")
class Defense(System):
    """Resolves a reach-in: in range of the carrier, a roll against the defender's
    steal chance takes the ball. Bots steal by their crew's style; you by the court's
    base chance. Your perks lengthen your reach and raise your odds."""

    @on(StealAttempted)
    def reach_in(self, ctx, event):
        ball_entity, ball = ctx.world.query(Ball).single()
        carrier, defender = ball.holder, event.by
        if carrier is None or ball_entity.has(Flight) or team_of(carrier) is team_of(defender):
            return
        court, edge, bot = ctx.config(CourtRules), defender.get(Edge), defender.try_get(Bot)
        reach = court.steal_range + edge.steal_range
        chance = (bot.style.steal_chance if bot is not None else court.steal_chance) + edge.steal_chance
        if defender.transform.position.distance_to(carrier.transform.position) > reach:
            return
        if random.random() >= chance:
            return
        give_ball(ctx, defender)
        ball.passer = None
        defender.get(BoxScore).steals += 1
        ctx.emit(BallStolen(by=defender, victim=carrier))
