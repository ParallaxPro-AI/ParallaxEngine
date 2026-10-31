from parallax import System, on, system
from project import Assets, Text

from game.audio import Sounds, play
from game.components import Ball, Home
from game.content import CupRules
from game.events import BallStruck, GoalScored, KeeperSaved, PossessionWon, Strike
from game.resources import Match
from game.rules import opponent


@system("atmosphere")
class Atmosphere(System):
    """Sound, effects and call-outs for what happens on the pitch. Changes no state."""

    @on(GoalScored)
    def goal(self, ctx, event):
        scorer = ctx.config(CupRules).club if event.team is Home else opponent(ctx).name
        ctx.ui.announce(Text.goal, scorer)
        play(ctx, ctx.config(Sounds).goal_cheer)
        ctx.vfx.play(Assets.vfx.goal_magic, at=event.goal.transform.position.with_y(1.6))
        ctx.camera.main.shake(0.35, 0.4)

    @on(BallStruck)
    def ball_struck(self, ctx, event):
        ball, _ = ctx.world.query(Ball).single()
        sounds = ctx.config(Sounds)
        play(ctx, sounds.pass_ball if event.kind is Strike.PASS else sounds.shot, at=ball)
        if event.kind is Strike.CLEARANCE:
            return  # a keeper's clearance kicks up dust only as a save (save)
        if event.by != ctx.get(Match).controlled:
            count = 6  # an AI striker's shot
        elif event.kind is Strike.PASS:
            count = 5
        else:
            count = 8
        ctx.vfx.play(Assets.vfx.turf_dust, at=ball.transform.position.with_y(0.25), count=count)

    @on(PossessionWon, where=lambda event: event.previous is not None)
    def turnover(self, ctx, event):
        if event.by.has(Home):
            play(ctx, ctx.config(Sounds).steal)
            ctx.ui.toast(Text.won_it_back)
        else:
            ctx.ui.toast(Text.lost_it)

    @on(KeeperSaved)
    def save(self, ctx, event):
        play(ctx, ctx.config(Sounds).save, at=event.keeper)
        ctx.vfx.play(Assets.vfx.turf_dust, at=event.keeper.transform.position.with_y(0.4), count=10)
        ctx.ui.toast(Text.keeper_save if event.keeper.has(Home) else Text.keeper_denied)
