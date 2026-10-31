"""Demo host for the console_terminal model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="console_terminal_demo", title="console_terminal demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
