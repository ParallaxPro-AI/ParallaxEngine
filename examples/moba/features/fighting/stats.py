"""A unit's numbers. Content gives each unit its base (`set_base`); items, buffs and
jungle rewards stack on top as stat modifiers (`add_stats`), so reading
`Stats.damage`, `Health.max` or `NavAgent.speed` gives the effective value."""

from parallax import Entity
from parallax.combat import Health
from parallax.nav import NavAgent

from features.fighting.components import Stats
from game.content import StatBlock


def set_base(unit: Entity, stats: StatBlock) -> None:
    """Write a unit's base numbers and fill its health. Health, armor and speed are
    the engine's fields; the rest live on Stats."""
    health = unit.get(Health)
    health.max = stats.max_health
    health.current = health.max
    health.armor = stats.damage_reduction
    agent = unit.try_get(NavAgent)
    if agent:
        agent.speed = stats.move_speed
    unit.add(Stats(max_mana=stats.max_mana, mana_regen=stats.mana_regen, damage=stats.damage,
                   ability_power=stats.ability_power, attack_range=stats.attack_range,
                   attack_interval=stats.attack_interval, dash_bonus=stats.dash_bonus))


def add_stats(unit: Entity, stats: StatBlock, *, key: str, seconds: float | None = None) -> None:
    """Stack `stats` on the unit as modifiers named `key`. The same key replaces what
    it stacked before; `seconds` makes it expire by itself."""
    for kind, name, amount in (
        (Health, "max", stats.max_health),
        (Health, "armor", stats.damage_reduction),
        (NavAgent, "speed", stats.move_speed),
        (Stats, "max_mana", stats.max_mana),
        (Stats, "mana_regen", stats.mana_regen),
        (Stats, "damage", stats.damage),
        (Stats, "ability_power", stats.ability_power),
        (Stats, "attack_range", stats.attack_range),
        (Stats, "attack_interval", stats.attack_interval),
        (Stats, "dash_bonus", stats.dash_bonus),
    ):
        if unit.has(kind):
            unit.modify(kind, name, add=amount, key=key, seconds=seconds)
