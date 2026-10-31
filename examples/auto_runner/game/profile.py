"""The meta game: bests, the wallet, the Endless unlock and the Outfitter.

The only module that writes `Profile`. `bank` runs when a run ends (see
`systems/outcome.py`) or is abandoned from the pause menu; `buy` and `equip`
are the Outfitter's panel actions."""

from parallax import ContentRef

from game.content import OutfitDef
from game.resources import Profile, Run


def can_buy(profile: Profile, outfit: ContentRef[OutfitDef]) -> bool:
    data = outfit.data
    return (
        outfit not in profile.owned
        and profile.wallet >= data.cost
        and (data.requires is None or data.requires in profile.owned)
    )


def bank(ctx, won: bool):
    """Keep the run's best and its coins. Quitting never costs a good half-run;
    finishing the Journey unlocks Endless."""
    run = ctx.get(Run)
    profile = ctx.get(Profile)
    metres = int(run.distance)
    if run.endless and metres > profile.best_endless:
        profile.best_endless, run.new_best = metres, True
    elif not run.endless and metres > profile.best_journey:
        profile.best_journey, run.new_best = metres, True
    profile.wallet += run.coins
    if won:
        profile.wins += 1
        profile.endless_unlocked = True


def buy(ctx, outfit: ContentRef[OutfitDef]):
    """Outfitter action: pay for an outfit and wear it straight away."""
    profile = ctx.get(Profile)
    if not can_buy(profile, outfit):
        return
    profile.wallet -= outfit.data.cost
    profile.owned.append(outfit)
    profile.outfit = outfit


def equip(ctx, outfit: ContentRef[OutfitDef]):
    """Outfitter action: wear an outfit already owned."""
    profile = ctx.get(Profile)
    if outfit in profile.owned:
        profile.outfit = outfit
