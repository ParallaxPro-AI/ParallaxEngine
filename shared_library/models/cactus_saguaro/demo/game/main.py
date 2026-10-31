"""Demo host for the cactus_saguaro model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cactus_saguaro_demo", title="cactus_saguaro demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
