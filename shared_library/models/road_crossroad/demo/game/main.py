"""Demo host for the road_crossroad model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="road_crossroad_demo", title="road_crossroad demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
