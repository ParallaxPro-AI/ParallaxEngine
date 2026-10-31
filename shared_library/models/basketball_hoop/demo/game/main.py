"""Demo host for the basketball_hoop model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="basketball_hoop_demo", title="basketball_hoop demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
