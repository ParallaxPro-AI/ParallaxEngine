"""Demo host for the vr_headset model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="vr_headset_demo", title="vr_headset demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
