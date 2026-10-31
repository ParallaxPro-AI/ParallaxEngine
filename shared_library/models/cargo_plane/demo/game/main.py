"""Demo host for the cargo_plane model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cargo_plane_demo", title="cargo_plane demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
