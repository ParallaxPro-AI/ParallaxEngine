"""Fighting: stats, basic attacks and targeting, shared by champions, minions, towers
and jungle camps. Damage and shields are the combat plugin's (`Health.damage`,
`Health.add_shield`); nothing here wraps them."""

from parallax import Feature

from features.fighting.components import Animations, Attacker, Stats
from features.fighting.stats import add_stats, set_base
from features.fighting.steering import chase, walk_to
from features.fighting.targeting import can_fight, distance, enemies_near, nearest_enemy

fighting = Feature("fighting", doc="Stats, basic attacks and targeting.")

__all__ = [
    "fighting", "Animations", "Attacker", "Stats", "add_stats", "set_base",
    "can_fight", "chase", "distance", "enemies_near", "nearest_enemy", "walk_to",
]
