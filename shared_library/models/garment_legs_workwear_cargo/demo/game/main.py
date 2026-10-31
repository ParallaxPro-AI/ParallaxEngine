"""Demo host for the garment_legs_workwear_cargo model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="garment_legs_workwear_cargo_demo", title="garment_legs_workwear_cargo demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
