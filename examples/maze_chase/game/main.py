from parallax import Game
from parallax.plugins import grid
from project import Scenes

from game.systems.feedback import Feedback
from game.systems.hunt import HuntClock
from game.systems.levels import Levels
from game.systems.outcome import Outcome
from game.systems.pace import PaceTuner
from game.systems.scoring import Scoring

game = Game(
    id="maze_chase",
    title="Glow Gobbler",
    sdk="1.0",
    mode="2d",
    plugins=[grid()],
    # Scoring before Outcome (the level bonus counts toward the best score);
    # Outcome before Levels (no new round once the last life is gone).
    systems=[Scoring, Outcome, Levels, HuntClock, PaceTuner, Feedback],
    start_scene=Scenes.title,
)
