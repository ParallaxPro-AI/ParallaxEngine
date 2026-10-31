"""Demo host for the vip_rope_lounge_sofa model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="vip_rope_lounge_sofa_demo", title="vip_rope_lounge_sofa demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
