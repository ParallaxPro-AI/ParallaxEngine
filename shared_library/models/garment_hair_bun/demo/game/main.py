"""Demo host for the garment_hair_bun model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="garment_hair_bun_demo", title="garment_hair_bun demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
