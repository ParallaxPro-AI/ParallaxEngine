"""Demo host for the shield_round_viking model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="shield_round_viking_demo", title="shield_round_viking demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
