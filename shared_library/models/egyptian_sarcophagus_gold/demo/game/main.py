"""Demo host for the egyptian_sarcophagus_gold model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="egyptian_sarcophagus_gold_demo", title="egyptian_sarcophagus_gold demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
