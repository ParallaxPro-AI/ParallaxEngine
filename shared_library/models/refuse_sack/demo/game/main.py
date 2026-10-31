"""Demo host for the refuse_sack model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="refuse_sack_demo", title="refuse_sack demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
