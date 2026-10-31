"""Demo host for the mana_potion model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mana_potion_demo", title="mana_potion demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
