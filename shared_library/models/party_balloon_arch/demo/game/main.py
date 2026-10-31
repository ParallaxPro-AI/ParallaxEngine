"""Demo host for the party_balloon_arch model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="party_balloon_arch_demo", title="party_balloon_arch demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
