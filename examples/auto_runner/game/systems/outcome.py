"""How a run ends."""

from parallax import System, on, system
from project import Assets, Scenes

from game.config import Canyon, Sounds
from game.events import RunEnded
from game.profile import bank
from game.components import Runner
from game.resources import Run, running


@system("outcome", scenes=[Scenes.canyon])
class Outcome(System):
    """Stops the world, banks the run and plays the crash or the fanfare. The
    end card follows a beat later on its own (`WipedOut` / `FarRim` open when
    `card_at` passes), and since it's modal the game freezes behind it.

    Only the first `RunEnded` counts: a hit and the finish line can land on the
    same frame, and the run must be banked once."""

    @on(RunEnded, when=running)
    def ended(self, ctx, event: RunEnded):
        cfg = ctx.config(Canyon)
        run = ctx.get(Run)
        run.over, run.won, run.killer, run.speed = True, event.won, event.killer, 0.0
        run.card_at = ctx.time.now + cfg.end_card_delay
        bank(ctx, won=event.won)
        # The template's shockwave2d at the runner: a full ring on the crash and at the rim.
        for runner in ctx.world.query(tagged=Runner).entities():
            ctx.vfx.play(Assets.vfx.hit_shock, at=runner)
        ctx.audio.music(None)
        if event.won:
            ctx.audio.play(ctx.config(Sounds).win)
        else:
            ctx.audio.play(ctx.config(Sounds).crash)
            ctx.camera.main.shake(cfg.hit_shake)
