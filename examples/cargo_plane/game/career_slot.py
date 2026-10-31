"""A career lives in the "career" save slot. Start Engine on the title picks it up where
it was left (or starts one); Play Again on the game-over screen starts a fresh one at the
home strip."""

from parallax import Context
from project import Scenes


def start_engine(ctx: Context) -> None:
    if ctx.save.exists("career"):
        ctx.save.load("career")
    else:
        new_career(ctx)


def new_career(ctx: Context) -> None:
    ctx.save.delete("career")
    ctx.scenes.load(Scenes.archipelago, new_run=True)
