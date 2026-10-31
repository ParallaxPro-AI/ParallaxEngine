"""Demo host for the radio_tower_broken model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="radio_tower_broken_demo", title="radio_tower_broken demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
