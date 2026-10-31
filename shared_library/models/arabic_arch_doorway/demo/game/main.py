"""Demo host for the arabic_arch_doorway model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="arabic_arch_doorway_demo", title="arabic_arch_doorway demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
