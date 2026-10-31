"""The canyon behind the title menu."""

from parallax import System, system
from project import Scenes

from game.systems.course import open_course


@system("title_backdrop", scenes=[Scenes.title])
class TitleBackdrop(System):
    """Behind the title menu the canyon drifts by at the run's opening speed,
    painted like its first stage."""

    def start(self, ctx):
        open_course(ctx)
