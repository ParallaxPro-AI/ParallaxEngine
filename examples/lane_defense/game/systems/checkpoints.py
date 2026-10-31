"""Keeps the mid-wave checkpoint, as the template did: every 3 seconds of play and
whenever the pause menu opens ("Your garden is saved automatically"). Rebuilds the
garden after the title's Continue."""

from parallax import PanelOpened, SceneLoaded, System, Timer, field, on, resource, system
from project import Scenes

from game.checkpoint import Checkpoint, rebuild_garden, save_checkpoint
from game.systems.outcome import playing
from game.ui import PauseMenu

AUTOSAVE_SECONDS = 3


@resource("autosave")
class Autosave:
    timer: Timer = field(Timer.delay(AUTOSAVE_SECONDS, repeat=True))


@system("checkpoints", scenes=[Scenes.garden])
class Checkpoints(System):
    @on(SceneLoaded)
    def resume(self, ctx, event):
        if ctx.get(Checkpoint).resuming:
            rebuild_garden(ctx)

    @on(PanelOpened, when=playing, where=lambda event: event.panel is PauseMenu)
    def paused(self, ctx, event):
        save_checkpoint(ctx)

    def update(self, ctx, dt):
        if playing(ctx) and ctx.get(Autosave).timer.tick(dt):
            save_checkpoint(ctx)
