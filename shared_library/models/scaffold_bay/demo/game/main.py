"""Demo host for the scaffold_bay model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="scaffold_bay_demo", title="scaffold_bay demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
