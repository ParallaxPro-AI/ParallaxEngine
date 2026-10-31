"""Starting, continuing and leaving a run: the title and menu buttons that do more than one thing."""

from parallax import Context
from project import Scenes


def walk_the_road(ctx: Context) -> None:
    """The title's one button. The journey is saved as you play, so it picks up the autosave when
    there is one and starts the story otherwise."""
    if ctx.save.exists("auto"):
        ctx.save.load("auto")
    else:
        ctx.scenes.load(Scenes.sundermere, new_run=True)


def save_and_quit(ctx: Context) -> None:
    ctx.save.save("auto")
    ctx.scenes.load(Scenes.title)
