"""Armor Assault: a tank campaign across four battlefields."""

from parallax import Game
from parallax.plugins import combat, foliage, hud, nav, physics3d, terrain, vehicles, wind
from project import Scenes

from game.damage import tank_armor
from game.layers import Layers
from game.systems.battle import Battle
from game.systems.grounding import Grounding
from game.systems.scoring import Scoring
from game.systems.workshop import FieldWorkshop

game = Game(
    id="tank_battle",
    title="Armor Assault",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.title,
    plugins=[
        physics3d(layers=Layers),
        terrain(),
        foliage(),
        wind(),
        vehicles(),
        combat(modifiers=[tank_armor]),
        nav(agent_radius=1.6, cell_size=1.5),
        hud(),
    ],
    systems=[Grounding, Battle, Scoring, FieldWorkshop],
)
