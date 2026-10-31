"""Demo host for the chinese_moon_gate model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="chinese_moon_gate_demo", title="chinese_moon_gate demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
