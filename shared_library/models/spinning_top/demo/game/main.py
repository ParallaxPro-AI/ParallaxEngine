"""Demo host for the spinning_top model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="spinning_top_demo", title="spinning_top demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
