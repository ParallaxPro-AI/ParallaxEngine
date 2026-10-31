"""Demo host for the persian_rug_rolled model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="persian_rug_rolled_demo", title="persian_rug_rolled demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
