"""Demo host for the halfling_villager model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="halfling_villager_demo", title="halfling_villager demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
