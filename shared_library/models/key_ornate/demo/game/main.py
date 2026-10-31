"""Demo host for the key_ornate model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="key_ornate_demo", title="key_ornate demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
