"""Demo host for the respawn_totem model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="respawn_totem_demo", title="respawn_totem demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
