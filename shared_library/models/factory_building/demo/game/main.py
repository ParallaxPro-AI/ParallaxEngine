"""Demo host for the factory_building model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="factory_building_demo", title="factory_building demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
