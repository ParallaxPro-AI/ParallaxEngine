from parallax import Game
from parallax.plugins import combat, hud, net, physics3d, softbody, vehicles, water, weather, wind
from project import Prefabs, Scenes

from game.behaviors.helm import HelmBehavior
from game.systems.bounties import Bounties
from game.systems.contracts import Contracts
from game.systems.fleet import Fleet
from game.systems.leg_clock import LegClock
from game.systems.sail_canvas import SailCanvas
from game.systems.treasure import Treasure
from game.systems.voyage_director import VoyageDirector
from game.systems.weather import Weather
from game.ui import BoardCrew

game = Game(
    id="pirate_sailing",
    title="Buccaneer Bay",
    sdk="1.0",
    mode="3d",
    plugins=[
        physics3d(),
        water(),
        weather(),
        wind(),
        softbody(),
        vehicles(),
        combat(),
        hud(),
        net(max_players=6, player_prefab=Prefabs.player_ship, mode="host", predict=[HelmBehavior]),
    ],
    systems=[VoyageDirector, LegClock, Fleet, Weather, Treasure, Bounties, Contracts, SailCanvas, BoardCrew],
    start_scene=Scenes.bay,
)
