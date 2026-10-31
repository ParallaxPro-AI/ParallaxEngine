"""Demo host for the street_planter model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="street_planter_demo", title="street_planter demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
