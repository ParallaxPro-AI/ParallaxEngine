"""Demo host for the vtol_dropship model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="vtol_dropship_demo", title="vtol_dropship demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
