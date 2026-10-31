"""Demo host for the battle_ropes model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="battle_ropes_demo", title="battle_ropes demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
