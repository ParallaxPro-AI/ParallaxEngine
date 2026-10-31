"""Demo host for the venetian_gondola model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="venetian_gondola_demo", title="venetian_gondola demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
