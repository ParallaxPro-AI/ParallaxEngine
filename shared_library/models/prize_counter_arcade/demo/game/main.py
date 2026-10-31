"""Demo host for the prize_counter_arcade model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="prize_counter_arcade_demo", title="prize_counter_arcade demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
