"""Demo host for the cactus_prickly_pear model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cactus_prickly_pear_demo", title="cactus_prickly_pear demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
