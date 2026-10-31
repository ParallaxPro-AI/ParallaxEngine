from parallax import Game
from parallax.plugins import characters, hud, physics3d, screens, terrain
from project import Scenes

from game.systems.ball_in_air import BallInAir
from game.lib.barks import Barks
from game.systems.commentary import Commentary
from game.systems.crew_barks import CrewBarks
from game.systems.court_tactics import CourtTactics
from game.systems.defense import Defense
from game.systems.game_clock import GameClock
from game.systems.passing import Passing
from game.systems.rebounds import Rebounds
from game.systems.restarts import Restarts
from game.systems.season import Season
from game.systems.shooting import Shooting

game = Game(
    id="basketball",
    title="Court Clash",
    sdk="1.0",
    mode="3d",
    plugins=[physics3d(), characters(), hud(), screens(), terrain()],
    systems=[
        CourtTactics,
        Passing,
        Shooting,
        Defense,
        BallInAir,
        Rebounds,
        GameClock,
        Restarts,
        Season,
        Commentary,
        CrewBarks,
        Barks,
    ],
    start_scene=Scenes.court,
)
