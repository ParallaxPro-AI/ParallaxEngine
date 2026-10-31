"""Demo host for the castle_tower model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="castle_tower_demo", title="castle_tower demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
