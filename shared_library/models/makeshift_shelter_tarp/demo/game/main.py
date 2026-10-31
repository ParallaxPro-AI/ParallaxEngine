"""Demo host for the makeshift_shelter_tarp model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="makeshift_shelter_tarp_demo", title="makeshift_shelter_tarp demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
