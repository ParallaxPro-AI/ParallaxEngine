"""Demo host for the fuel_canister model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fuel_canister_demo", title="fuel_canister demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
