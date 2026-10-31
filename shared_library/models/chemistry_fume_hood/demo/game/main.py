"""Demo host for the chemistry_fume_hood model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="chemistry_fume_hood_demo", title="chemistry_fume_hood demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
