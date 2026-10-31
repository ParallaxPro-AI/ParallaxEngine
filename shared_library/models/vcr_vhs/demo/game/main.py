"""Demo host for the vcr_vhs model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="vcr_vhs_demo", title="vcr_vhs demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
