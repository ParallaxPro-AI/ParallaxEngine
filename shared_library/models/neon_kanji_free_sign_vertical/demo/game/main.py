"""Demo host for the neon_kanji_free_sign_vertical model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="neon_kanji_free_sign_vertical_demo", title="neon_kanji_free_sign_vertical demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
