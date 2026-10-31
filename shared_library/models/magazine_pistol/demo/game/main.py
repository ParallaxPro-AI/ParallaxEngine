"""Demo host for the magazine_pistol model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="magazine_pistol_demo", title="magazine_pistol demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
