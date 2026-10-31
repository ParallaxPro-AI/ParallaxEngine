"""Demo host for the garment_legs_trousers_plain model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="garment_legs_trousers_plain_demo", title="garment_legs_trousers_plain demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
