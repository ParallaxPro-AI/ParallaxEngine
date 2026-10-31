"""Demo host for the chemistry_glassware model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="chemistry_glassware_demo", title="chemistry_glassware demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
