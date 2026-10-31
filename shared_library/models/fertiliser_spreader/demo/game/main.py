"""Demo host for the fertiliser_spreader model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fertiliser_spreader_demo", title="fertiliser_spreader demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
