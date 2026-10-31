"""Demo host for the scroll_rolled_sealed model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="scroll_rolled_sealed_demo", title="scroll_rolled_sealed demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
