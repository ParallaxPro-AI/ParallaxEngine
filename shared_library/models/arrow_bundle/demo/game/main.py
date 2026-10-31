"""Demo host for the arrow_bundle model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="arrow_bundle_demo", title="arrow_bundle demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
