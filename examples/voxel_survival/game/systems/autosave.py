from parallax import PanelOpened, System, on, system
from project import Scenes

from features.survival.feature import Slept
from game.config import Rules
from game.ui import PauseMenu


@system("autosave", scenes=[Scenes.greenwood])
class Autosave(System):
    """Saves the world every few seconds of play, whenever the game is paused (so
    the pause menu's Quit has nothing left to save) and after a night's sleep."""

    def start(self, ctx):
        ctx.time.every(ctx.config(Rules).autosave_every, lambda: ctx.save.save("world"))

    @on(PanelOpened, where=lambda event: event.panel is PauseMenu)
    def paused(self, ctx, event: PanelOpened):
        ctx.save.save("world")

    @on(Slept)
    def slept(self, ctx, event: Slept):
        ctx.save.save("world")
