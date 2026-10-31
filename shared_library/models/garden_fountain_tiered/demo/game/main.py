"""Demo host for the garden_fountain_tiered model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="garden_fountain_tiered_demo", title="garden_fountain_tiered demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
