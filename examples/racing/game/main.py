from parallax import Game
from parallax.plugins import cinematics, foliage, hud, physics3d, procgen, softbody, terrain, vehicles, weather, wind
from project import Scenes

from game.actions import IntroControls
from game.lib.ghost_racer import GhostKeeper
from game.lib.time_trial import TrialClock
from game.systems.championship import Championship
from game.systems.lap_counting import LapCounting
from game.systems.race_setup import RaceSetup
from game.systems.showroom import Showroom
from game.systems.standings import Standings

game = Game(
    id="racing",
    title="Street Racer",
    sdk="1.0",
    mode="3d",
    plugins=[physics3d(), softbody(), vehicles(), terrain(), procgen(), foliage(), wind(), weather(), hud(), cinematics(skip=IntroControls.skip)],
    systems=[Showroom, RaceSetup, LapCounting, Standings, Championship, TrialClock, GhostKeeper],
    start_scene=Scenes.title,
)
