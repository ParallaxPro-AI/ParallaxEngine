"""Demo host for the battle_tank model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d, vehicles
from project import Scenes

game = Game(id="battle_tank_demo", title="battle_tank demo", sdk="1.0", mode="3d",
            plugins=[physics3d(), vehicles()], start_scene=Scenes.yard)
