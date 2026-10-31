"""Canyon Dash: a two-button side-scrolling runner through five stretches of canyon."""

from parallax import Game
from parallax.plugins import combat, physics2d
from project import Scenes

from game.systems.coins import Coins
from game.systems.course import Course
from game.systems.feed import HazardFeed
from game.systems.hits import Hits
from game.systems.outcome import Outcome
from game.systems.scroller import Scroller
from game.systems.title import TitleBackdrop

game = Game(
    id="auto_runner",
    title="Canyon Dash",
    sdk="1.0",
    mode="2d",
    # Zero gravity: the runner flies its own exact hop and nothing else falls.
    # Physics is here only for the trigger overlaps (hazards, coins); combat
    # gives the runner its hearts and the blink after a hit.
    plugins=[physics2d(gravity=0), combat()],
    # Course must start before HazardFeed: the feed seeds hazards at the speed
    # and stage the course has just set.
    systems=[Course, HazardFeed, Coins, Scroller, Hits, Outcome, TitleBackdrop],
    start_scene=Scenes.title,
)
