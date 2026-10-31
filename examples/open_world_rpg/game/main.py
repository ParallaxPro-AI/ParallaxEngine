"""Sundermere — an open-world RPG in a lantern-lit realm.

The plugin list is the capability list; the feature list is the table of contents.
"""

from parallax import Game, plugins
from project import Scenes

from features.combat.feature import combat, weakness
from features.companion.feature import companion
from features.hero.feature import hero
from features.inventory.feature import inventory
from features.quests.feature import quests

game = Game(
    id="sundermere",
    title="Sundermere",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.title,
    plugins=[
        plugins.physics3d(),
        plugins.hud(),
        plugins.weather(),
        plugins.terrain(),
        plugins.foliage(),
        plugins.procgen(),
        plugins.characters(),
        plugins.nav(),
        plugins.combat(modifiers=[weakness], min_damage=1),
        plugins.story(),
        plugins.save(),
    ],
    features=[hero, inventory, combat, companion, quests],
    save_version=3,
)
