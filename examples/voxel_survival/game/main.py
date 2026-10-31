"""Greenwood: a voxel survival sandbox.

Mine and build in a generated block world, craft your way up the tool ladder, keep
fed, and get a roof over your head before the things that come out at night find
your door. Everything the world remembers is saved to one slot.
"""

from parallax import Game
from parallax.plugins import characters, combat, hud, physics3d, save, viewmodel, voxels, weather
from project import Scenes

from features.creatures.feature import creatures
from features.inventory.feature import inventory
from features.player.feature import player
from features.progress.feature import progress
from features.survival.feature import survival
from features.world.feature import world
from game.systems.autosave import Autosave

game = Game(
    id="voxel_survival",
    title="Greenwood",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.title,
    plugins=[
        voxels(chunk_size=16, save_edits=True),
        physics3d(gravity=-26),
        characters(),
        combat(),
        save(),
        hud(),
        weather(),
        viewmodel(),
    ],
    features=[inventory, world, player, survival, creatures, progress],
    systems=[Autosave],
    save_version=1,
)
