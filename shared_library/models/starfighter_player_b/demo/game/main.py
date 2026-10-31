"""Demo host for the starfighter_player_b model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="starfighter_player_b_demo", title="starfighter_player_b demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
