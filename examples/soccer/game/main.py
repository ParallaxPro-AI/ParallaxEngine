from parallax import Game
from parallax.plugins import characters, physics3d
from project import Scenes

from game.systems.atmosphere import Atmosphere
from game.systems.cup_run import CupRun
from game.systems.fatigue import Fatigue
from game.systems.human_control import HumanControl
from game.systems.match_flow import MatchFlow
from game.systems.possession import Possession
from game.systems.team_tactics import TeamTactics

game = Game(
    id="soccer",
    title="Continental Cup",
    sdk="1.0",
    mode="3d",
    plugins=[physics3d(), characters()],
    systems=[
        HumanControl,
        TeamTactics,
        Possession,
        Fatigue,
        MatchFlow,
        CupRun,
        Atmosphere,
    ],
    start_scene=Scenes.stadium,
)
