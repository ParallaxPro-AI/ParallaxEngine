"""Demo host for the boat_trailer model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="boat_trailer_demo", title="boat_trailer demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
