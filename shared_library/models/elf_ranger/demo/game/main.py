"""Demo host for the elf_ranger model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="elf_ranger_demo", title="elf_ranger demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
