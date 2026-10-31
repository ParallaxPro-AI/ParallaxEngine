"""Demo host for barks: a guard, a villager and a hero."""

from parallax import Game, tag
from parallax.plugins import combat
from project import Scenes

from game.lib.barks import Barks
from game.lib.hurt_barks import HurtBarks

Hero = tag("hero")

game = Game(id="barks_demo", title="Barks demo", sdk="1.0", mode="3d",
            plugins=[combat()], systems=[Barks, HurtBarks], start_scene=Scenes.town)
