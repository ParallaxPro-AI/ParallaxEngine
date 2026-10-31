from parallax import Context, ContentRef, System, on, system

from game.rules import Sounds
from game.content import BoonDef
from game.events import BossSlain, RunBanked
from game.resources import Vault


@system("vault_keeper")
class VaultKeeper(System):
    """The meta layer: banks every finished run's coins and keeps the records the title
    screen shows. Boons are bought between runs with `buy_boon`."""

    @on(RunBanked)
    def banked(self, ctx, event: RunBanked):
        vault = ctx.get(Vault)
        vault.coins += event.coins
        vault.lifetime_coins += event.coins
        vault.runs += 1
        vault.best_floor = max(vault.best_floor, event.floor)
        if event.won:
            vault.wins += 1

    @on(BossSlain)
    def boss_slain(self, ctx, event: BossSlain):
        ctx.get(Vault).boss_kills += 1


def buy_boon(ctx: Context, boon: ContentRef[BoonDef]) -> None:
    """The vault panel's buy button: the next level of a boon, if you can afford it."""
    vault = ctx.get(Vault)
    level = vault.levels.get(boon, 0)
    costs = boon.data.costs
    if level == len(costs) or vault.coins < costs[level]:
        ctx.audio.play(ctx.config(Sounds).denied)
        return
    vault.coins -= costs[level]
    vault.levels[boon] = level + 1
    ctx.audio.play(ctx.config(Sounds).buy)
