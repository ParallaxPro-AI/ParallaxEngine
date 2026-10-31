"""Demo host for save_slots."""

from parallax import Game, resource
from parallax.plugins import save
from project import Scenes


@resource("demo_run")
class DemoRun:
    coins: int = 0


game = Game(id="save_slots_demo", title="Save slots demo", sdk="1.0", mode="2d",
            plugins=[save()], start_scene=Scenes.title)
