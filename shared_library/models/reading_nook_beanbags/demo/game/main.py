"""Demo host for the reading_nook_beanbags model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="reading_nook_beanbags_demo", title="reading_nook_beanbags demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
