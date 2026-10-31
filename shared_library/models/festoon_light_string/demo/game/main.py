"""Demo host for the festoon_light_string model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="festoon_light_string_demo", title="festoon_light_string demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
