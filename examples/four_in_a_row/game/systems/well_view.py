from parallax import System, on, system
from project import Prefabs, Scenes

from game.board import slot
from game.config import Rules
from game.events import DiscDropped, MatchEnded
from game.resources import Match, Result
from game.well import Disc

DISC_PREFABS = {Disc.AMBER: Prefabs.disc_amber, Disc.TEAL: Prefabs.disc_teal}


@system("well_view", scenes=[Scenes.well])
class WellView(System):
    """Draws the well: each dropped disc falls from the lane above into its slot,
    and a connected four is ringed."""

    @on(DiscDropped)
    def show_drop(self, ctx, event: DiscDropped):
        rules = ctx.config(Rules)
        landing = slot(ctx, event.cell)
        disc = ctx.world.spawn(DISC_PREFABS[event.disc], at=landing.with_y(rules.lane_y))
        disc.transform.move_to(landing, rules.fall_seconds, ease="out_quad")
        ctx.audio.play(rules.sounds.drop, volume=0.36)

    @on(MatchEnded)
    def show_result(self, ctx, event: MatchEnded):
        for cell in ctx.get(Match).winning_line:
            ctx.world.spawn(Prefabs.win_marker, at=slot(ctx, cell))
        if event.result is not Result.DRAW:
            ctx.camera.main.shake(0.14, 0.2)
            ctx.audio.play(ctx.config(Rules).sounds.connect, volume=0.5)
