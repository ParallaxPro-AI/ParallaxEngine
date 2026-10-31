from parallax import Context, Entity, Model

from features.fighting.feature import Animations, Attacker, Stats, set_base
from features.heroes.components import AbilityBook, Hero, Mana


def equip_champion(ctx: Context, hero: Entity) -> None:
    """Turn the hero body that drafted into its champion: model, size, animations,
    base stats plus passive, and the ability kit. Starts full."""
    champion = hero.get(Hero).champion.data
    hero.get(Model).model = champion.model
    hero.transform.scale = champion.scale
    hero.get(Animations).clips = champion.clips
    hero.get(Attacker).bolt = champion.bolt
    hero.get(AbilityBook).abilities = list(champion.abilities)
    set_base(hero, champion.stats + champion.passive)
    hero.get(Mana).current = hero.get(Stats).max_mana
