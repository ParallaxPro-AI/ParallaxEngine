"""Demo host for the cannon_deck_carriage model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cannon_deck_carriage_demo", title="cannon_deck_carriage demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
