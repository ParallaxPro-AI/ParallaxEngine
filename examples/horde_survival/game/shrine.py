"""Between runs, from the title screen: dust buys permanent perk levels (each dearer than
the last), a survived run unlocks the Ashen Vigil, and the circle is lit with a chosen
seed. Each function is a panel action (see game/ui.py)."""

from parallax import Context, ContentRef
from project import Scenes

from game.content import PerkDef
from game.resources import Choices, Records
from game.rules import Rules, play, vigil_unlocked


def perk_cost(perk: PerkDef, level: int) -> int:
    return perk.cost + perk.cost_step * level


def buy_perk(ctx: Context, perk: ContentRef[PerkDef]) -> None:
    """The shrine's buy button: the perk's next level, if it isn't maxed and you can pay."""
    records = ctx.get(Records)
    level = records.perk_levels.get(perk, 0)
    cost = perk_cost(perk.data, level)
    if level == perk.data.max_level or records.dust < cost:
        play(ctx, ctx.config(Rules).sounds.denied)
        return
    records.dust -= cost
    records.perk_levels[perk] = level + 1
    play(ctx, ctx.config(Rules).sounds.buy)


def toggle_vigil(ctx: Context) -> None:
    """Switch the Ashen Vigil on or off for the next run (once it's unlocked)."""
    choices = ctx.get(Choices)
    choices.vigil = vigil_unlocked(ctx) and not choices.vigil


def light_circle(ctx: Context, seed: int) -> None:
    """Start a run. Seed 0 (the box left blank) rolls a fresh one."""
    ctx.scenes.load(Scenes.arena, new_run=True, seed=seed or None)
