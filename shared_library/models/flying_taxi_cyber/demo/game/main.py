"""Demo host for the flying_taxi_cyber model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="flying_taxi_cyber_demo", title="flying_taxi_cyber demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
