"""Demo host for the outdoor_stage model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="outdoor_stage_demo", title="outdoor_stage demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
