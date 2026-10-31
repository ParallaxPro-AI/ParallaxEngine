"""Demo host for the fire_pit_bowl model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fire_pit_bowl_demo", title="fire_pit_bowl demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
