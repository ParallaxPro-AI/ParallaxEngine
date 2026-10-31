"""Demo host for the bait_bucket model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bait_bucket_demo", title="bait_bucket demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
