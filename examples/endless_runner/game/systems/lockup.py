"""The Lock-Up and the profile: wallet, records and upgrades.

The only module that writes `Profile`. `keep_records` runs when a run ends
(see `systems/escape.py`) or is abandoned from the pause menu; `buy` is the
Lock-Up panel's action."""

from parallax import ContentRef, System, on, system

from game.content import UpgradeDef, UpgradeEffect
from game.events import CoinsEarned
from game.resources import Profile, Run


def level_of(profile: Profile, upgrade: ContentRef[UpgradeDef]) -> int:
    return profile.upgrades.get(upgrade, 0)


def next_cost(profile: Profile, upgrade: ContentRef[UpgradeDef]) -> int | None:
    """The price of the next level, or None at the cap."""
    costs = upgrade.data.costs
    level = level_of(profile, upgrade)
    return costs[level] if level < len(costs) else None


def buy(ctx, upgrade: ContentRef[UpgradeDef]):
    """Lock-Up action: pay for the next level of an upgrade."""
    profile = ctx.get(Profile)
    cost = next_cost(profile, upgrade)
    if cost is None or profile.wallet < cost:
        return
    profile.wallet -= cost
    profile.upgrades[upgrade] = level_of(profile, upgrade) + 1


def apply_upgrades(ctx):
    """Turn the levels bought at the Lock-Up into this run's modifiers."""
    run = ctx.get(Run)
    for upgrade, level in ctx.get(Profile).upgrades.items():
        effect, amount = upgrade.data.effect, upgrade.data.per_level * level
        if effect is UpgradeEffect.GUARD_HEADROOM:
            run.gap_max += amount
        elif effect is UpgradeEffect.GUARD_RECOVER:
            run.recover_bonus += amount
        elif effect is UpgradeEffect.MAGNET_RADIUS:
            run.passive_magnet += amount
        elif effect is UpgradeEffect.COIN_VALUE:
            run.coin_value += amount
        elif effect is UpgradeEffect.START_SHIELD:
            run.shields += int(amount)
        elif effect is UpgradeEffect.STREET_MAPS:
            run.powerup_bonus += amount


def keep_records(ctx, won: bool):
    """Bests from a finished (or abandoned) run. The first escape unlocks Night Shift."""
    run = ctx.get(Run)
    profile = ctx.get(Profile)
    run.prev_best_distance = profile.best_distance
    run.new_best = run.score > profile.best_score
    profile.best_score = max(profile.best_score, run.score)
    profile.best_distance = max(profile.best_distance, int(run.distance))
    profile.best_combo = max(profile.best_combo, run.best_combo)
    if won:
        profile.escapes += 1
        profile.endless_unlocked = True


@system("lockup")
class LockUp(System):
    """Banks coins the instant they're earned, so even a busted
    run pays for the next upgrade."""

    @on(CoinsEarned)
    def bank(self, ctx, event: CoinsEarned):
        ctx.get(Profile).wallet += event.amount
