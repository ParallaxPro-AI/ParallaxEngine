"""Demo host for the game_controller model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="game_controller_demo", title="game_controller demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
