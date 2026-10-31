"""Demo host for the crab model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="crab_demo", title="crab demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
