from parallax import Game
from parallax.plugins import combat
from project import Scenes

from game.systems.bombs import Bombs
from game.systems.collisions import Collisions
from game.systems.drops import Drops
from game.systems.feedback import Feedback
from game.systems.motion import Motion
from game.systems.outcome import Outcome
from game.systems.scoring import Scoring
from game.systems.shrine import ShrineDraft
from game.systems.waves import Waves
from game.systems.wisp_rules import WispRules

game = Game(
    id="bullet_hell",
    title="Petal Storm",
    sdk="1.0",
    mode="2d",
    plugins=[combat()],
    # ShrineDraft before Waves and WispRules: a new attunement counts toward the
    # next wave and its own gifts. Scoring before Outcome: the win bonus counts
    # toward the best score.
    systems=[ShrineDraft, Waves, Collisions, WispRules, Bombs, Drops, Scoring, Outcome, Motion, Feedback],
    start_scene=Scenes.title,
)
