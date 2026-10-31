"""Demo host for the rusty_bathtub model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="rusty_bathtub_demo", title="rusty_bathtub demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
