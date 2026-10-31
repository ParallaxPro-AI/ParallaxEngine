"""Demo host for the road_work_sign model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="road_work_sign_demo", title="road_work_sign demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
