"""Demo host for the fireball_core model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fireball_core_demo", title="fireball_core demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
