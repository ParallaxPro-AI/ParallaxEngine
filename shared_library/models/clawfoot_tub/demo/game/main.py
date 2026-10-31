"""Demo host for the clawfoot_tub model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="clawfoot_tub_demo", title="clawfoot_tub demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
