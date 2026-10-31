"""Demo host for the halloween_pumpkin_patch_set model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="halloween_pumpkin_patch_set_demo", title="halloween_pumpkin_patch_set demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
