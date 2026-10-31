"""Demo host for the ladder_rope model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="ladder_rope_demo", title="ladder_rope demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
