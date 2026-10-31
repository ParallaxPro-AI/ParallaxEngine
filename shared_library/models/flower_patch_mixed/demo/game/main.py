"""Demo host for the flower_patch_mixed model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="flower_patch_mixed_demo", title="flower_patch_mixed demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
