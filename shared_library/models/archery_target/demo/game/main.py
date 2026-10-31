"""Demo host for the archery_target model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="archery_target_demo", title="archery_target demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
