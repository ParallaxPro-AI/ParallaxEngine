"""Demo host for the street_hoop model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="street_hoop_demo", title="street_hoop demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
