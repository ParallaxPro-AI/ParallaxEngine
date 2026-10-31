"""Demo host for the compost_heap model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="compost_heap_demo", title="compost_heap demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
