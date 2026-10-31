"""Demo host for the holo_billboard model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="holo_billboard_demo", title="holo_billboard demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
