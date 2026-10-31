"""Demo host for the info_totem model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="info_totem_demo", title="info_totem demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
