"""Demo host for the mushroom_cluster model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mushroom_cluster_demo", title="mushroom_cluster demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
