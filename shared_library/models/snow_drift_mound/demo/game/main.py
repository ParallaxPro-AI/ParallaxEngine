"""Demo host for the snow_drift_mound model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="snow_drift_mound_demo", title="snow_drift_mound demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
