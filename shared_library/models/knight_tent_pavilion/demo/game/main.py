"""Demo host for the knight_tent_pavilion model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="knight_tent_pavilion_demo", title="knight_tent_pavilion demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
