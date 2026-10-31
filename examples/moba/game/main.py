"""Lane Siege: a five-on-five lane battle, hosted by one player's game.

Two players draft a champion each, bots fill both teams, and the match is
won by destroying the enemy core. The server owns every rule. Clients send
input and RPCs, and render what the server lets them see.
"""

from parallax import Game
from parallax.plugins import chat, combat, foliage, hud, nav, net, physics3d, terrain, voice, weather
from project import Prefabs, Scenes

from features.abilities.feature import abilities
from features.bots.feature import bots
from features.comms.feature import comms
from features.economy.feature import economy
from features.fighting.feature import fighting
from features.heroes.feature import HeroMotor, PlayerOrders, heroes
from features.jungle.feature import jungle
from features.lanes.feature import core_guard, lanes
from features.match.feature import match
from features.soundscape.feature import soundscape
from features.vision.feature import vision, visible
from game.actions import Controls
from game.physics import Layers
from game.ui import TrainingPause

game = Game(
    id="moba",
    title="Lane Siege",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.title,
    plugins=[
        physics3d(layers=Layers),
        terrain(),
        foliage(),
        weather(),
        hud(),
        combat(modifiers=[core_guard]),
        nav(agent_radius=0.5, cell_size=1.5),
        net(max_players=2, player_prefab=Prefabs.hero, tick_rate=30, mode="host", visible=visible,
            predict=[PlayerOrders, HeroMotor]),
        chat(max_length=200),
        voice(mode="push_to_talk", talk=Controls.talk, positional=False),
    ],
    systems=[TrainingPause],
    features=[fighting, heroes, vision, abilities, economy, lanes, jungle, bots, match, comms, soundscape],
)
