"""Demo host for the potion_health model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="potion_health_demo", title="potion_health demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
