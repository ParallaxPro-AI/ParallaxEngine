"""Demo host for the floor_mirror_arched model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="floor_mirror_arched_demo", title="floor_mirror_arched demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
