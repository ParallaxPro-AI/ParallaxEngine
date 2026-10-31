from parallax import Color, System, on, system
from project import Assets

from game.audio import Sounds, play
from game.events import BallLaunched, BallLost, BallReturned, RailHit, RunEnded, StageCleared, UpgradePicked

RAIL_SPARK = Color.hex("#b3b3d9")
PADDLE_SPARK = Color.hex("#73bfff")
LOST_SPARK = Color.hex("#ff6666")


@system("feedback")
class Feedback(System):
    """Sounds, sparks, shake and rumble for the orb and for the moments that matter to
    the whole run (brick cracks are the brick's own). The arena's music is declared by
    its scene; the cues and their volumes are config/audio.json."""

    @on(BallLaunched)
    def launched(self, ctx, event: BallLaunched):
        play(ctx, ctx.config(Sounds).launch)

    @on(BallReturned)
    def returned(self, ctx, event: BallReturned):
        play(ctx, ctx.config(Sounds).paddle)
        ctx.vfx.play(Assets.vfx.sparks, at=event.at, color=PADDLE_SPARK)
        ctx.input.rumble(0.3, 0.01)

    @on(RailHit)
    def rail_hit(self, ctx, event: RailHit):
        play(ctx, ctx.config(Sounds).wall)
        ctx.vfx.play(Assets.vfx.rail_sparks, at=event.at, color=RAIL_SPARK)

    @on(BallLost)
    def ball_lost(self, ctx, event: BallLost):
        play(ctx, ctx.config(Sounds).lose_life)
        ctx.camera.main.shake(0.45, 0.2)
        ctx.vfx.play(Assets.vfx.lost_sparks, at=event.at, color=LOST_SPARK)

    @on(StageCleared, where=lambda event: not event.final)
    def stage_cleared(self, ctx, event: StageCleared):
        play(ctx, ctx.config(Sounds).stage_clear)

    @on(UpgradePicked)
    def upgrade_picked(self, ctx, event: UpgradePicked):
        play(ctx, ctx.config(Sounds).upgrade)

    @on(RunEnded)
    def run_ended(self, ctx, event: RunEnded):
        sounds = ctx.config(Sounds)
        play(ctx, sounds.victory if event.won else sounds.defeat)
