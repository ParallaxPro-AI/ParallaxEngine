"""Demo host for the dark_elf_assassin model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="dark_elf_assassin_demo", title="dark_elf_assassin demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
