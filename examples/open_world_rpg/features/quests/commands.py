"""Functions the .yarn conversations may call, and nothing else."""

from parallax import Context
from parallax.combat import Health
from parallax.story import dialogue_command

from features.hero.feature import Hero, Mana
from features.inventory.feature import ShopPanel


@dialogue_command("open_shop")
def open_shop(ctx: Context) -> None:
    """Dunmore's `<<open_shop>>`: the shop opens when the greeting ends."""
    ctx.ui.open(ShopPanel)


@dialogue_command("restore_hero")
def restore_hero(ctx: Context) -> None:
    """Sister Maelin's `<<restore_hero>>`: full health and mana."""
    for _, health, mana in ctx.world.query(Health, Mana, tagged=Hero):
        health.heal(health.max)
        mana.current = mana.max
