"""Demo host for the garment_face_sunglasses_aviator model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="garment_face_sunglasses_aviator_demo", title="garment_face_sunglasses_aviator demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
