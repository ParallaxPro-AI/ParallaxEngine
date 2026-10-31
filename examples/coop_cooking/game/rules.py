"""Lookups shared by systems, behaviors and panels."""

from parallax import Context, Entity, Player

from game.components import Chef
from game.content import Cue, Kitchen, ServiceRules
from game.resources import Service


def kitchen(ctx: Context) -> Kitchen:
    """The kitchen being cooked in now."""
    return ctx.config(ServiceRules).kitchens[ctx.get(Service).kitchen].data


def time_left(ctx: Context) -> float:
    """The kitchen's clock. `ctx.time.scene_time` is game time since this scene loaded and
    stops while a modal is open, so every kitchen starts its own clock at full."""
    return kitchen(ctx).seconds - ctx.time.scene_time


def penalize(ctx: Context, at_fault: Player, amount: int) -> None:
    """Take points from the seat at fault first, then from the others: the target is
    a team target, so a chef at zero can't serve wrong food for free."""
    scores = ctx.get(Service).scores
    for player in [at_fault] + [p for p in ctx.players if p != at_fault]:
        taken = min(scores[player.index], amount)
        scores[player.index] -= taken
        amount -= taken


def tell(ctx: Context, chef: Entity, text: str, bad: bool = False) -> None:
    """A line in this chef's feedback chip, under their task banner (their half only)."""
    hands = chef.get(Chef)
    hands.said = text
    hands.said_bad = bad
    hands.said_count += 1
    hands.said_at = ctx.time.now


def play(ctx: Context, cue: Cue | None, gain: float = 1) -> None:
    """A cue from the kitchen's sound map at its own volume."""
    if cue is not None:
        ctx.audio.play(cue.sound, volume=cue.volume * gain)
