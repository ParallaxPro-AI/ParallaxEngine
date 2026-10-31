"""The title's Play button: it resumes the safehouse save when there is one, like the template's single
Play (its crime_world read the saved cash and runs back in on start), and starts a new run otherwise."""

from parallax import Context
from project import Scenes


def play(ctx: Context) -> None:
    if ctx.save.exists("auto"):
        ctx.save.load("auto")
    else:
        ctx.scenes.load(Scenes.sunset_bay, new_run=True)
