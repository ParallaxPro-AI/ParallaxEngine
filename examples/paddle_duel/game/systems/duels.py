from parallax import Shape, System, TriggerEntered, on, system
from project import Scenes

from game.components import Ball, RivalGoal, RivalTint
from game.config import Rules
from game.events import DuelLost, DuelStarted, DuelWon, PerkPicked, RallyEnded
from game.progress import current_rival, is_final_rival, shields_left
from game.resources import Duel, Run


@system("duels", scenes=[Scenes.arena])
class Duels(System):
    """Runs the first-to-N duels: dresses the court in each rival's colour, awards
    points when the ball reaches a goal (refunding the rival's points while the
    player has Second Wind shields), and decides each duel."""

    def start(self, ctx):
        self.begin(ctx)

    @on(PerkPicked)
    def next_rival(self, ctx, event: PerkPicked):
        ctx.get(Run).rival_index += 1
        self.begin(ctx)

    @on(TriggerEntered, where=lambda event: event.target.has(Ball))
    def goal_reached(self, ctx, event: TriggerEntered):
        duel = ctx.get(Duel)
        player_scored = event.entity.has(RivalGoal)
        refunded = not player_scored and shields_left(ctx) > 0
        if player_scored:
            duel.player_points += 1
        elif refunded:
            duel.shields_used += 1
        else:
            duel.rival_points += 1
        ctx.emit(RallyEnded(player_scored=player_scored, refunded=refunded,
                              at=event.entity.transform.position))

        win_score = ctx.config(Rules).win_score
        if duel.player_points == win_score:
            ctx.emit(DuelWon(final=is_final_rival(ctx)))
        elif duel.rival_points == win_score:
            ctx.emit(DuelLost())

    def begin(self, ctx):
        ctx.reset(Duel)
        color = current_rival(ctx).color
        for entity in ctx.world.query(tagged=RivalTint):
            entity.get(Shape).color = color
        ctx.emit(DuelStarted(index=ctx.get(Run).rival_index))
