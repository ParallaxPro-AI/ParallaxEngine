"""Demo host for the garment_torso_hoodie model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="garment_torso_hoodie_demo", title="garment_torso_hoodie demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
