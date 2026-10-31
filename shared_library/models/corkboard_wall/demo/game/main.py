"""Demo host for the corkboard_wall model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="corkboard_wall_demo", title="corkboard_wall demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
