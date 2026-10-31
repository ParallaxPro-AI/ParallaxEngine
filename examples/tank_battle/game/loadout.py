"""Folding an upgrade into the campaign loadout: deltas add, multipliers multiply."""

from parallax import ContentRef

from game.content import UpgradeDef
from game.resources import Loadout


def apply_upgrade(loadout: Loadout, upgrade: ContentRef[UpgradeDef]) -> None:
    card = upgrade.data
    loadout.picks.append(upgrade)
    loadout.damage += card.damage
    loadout.max_health += card.max_health
    loadout.pierce = min(1.0, loadout.pierce + card.pierce)
    loadout.resist = min(0.75, loadout.resist + card.resist)
    loadout.splash_radius = max(loadout.splash_radius, card.splash_radius)
    loadout.splash_damage += card.splash_damage
    loadout.repair_bonus += card.repair_bonus
    loadout.extra_ammo += card.extra_ammo
    loadout.reload_mul *= card.reload_mul
    loadout.speed_mul *= card.speed_mul
    loadout.traverse_mul *= card.traverse_mul
