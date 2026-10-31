"""The hero's sword and the two ability slots."""

from parallax import Actions, Color, Context, button, gamepad, mouse, touch

from features.combat.components import Spellbook
from features.combat.content import AbilityDef
from features.hero.feature import Hero, Mana


def spell_left(ctx: Context, number: int) -> float:
    """0..1 of slot `number`'s recharge still to go (the template's gold recharge ring)."""
    row = ctx.world.query(Spellbook, tagged=Hero).first()
    spec = ctx.content(AbilityDef).first(lambda a: a.slot == number)
    if row is None or spec is None:
        return 0.0
    return min(1.0, row[1].cooldowns.get(spec, 0) / max(spec.data.cooldown, 0.01))


def spell_ready(ctx: Context, number: int) -> bool:
    """Known, recharged and affordable: the template disables the plate otherwise."""
    row = ctx.world.query(Spellbook, Mana, tagged=Hero).first()
    spec = ctx.content(AbilityDef).first(lambda a: a.slot == number)
    if row is None or spec is None:
        return False
    _, book, mana = row
    return spec in book.known and book.cooldowns.get(spec, 0) <= 0 and mana.current >= spec.data.mana_cost


class CombatControls(Actions):
    """Hold Strike to keep swinging; Q and R cast whatever the spellbook holds in slots 1 and 2."""

    strike = button(keyboard="KeyJ", gamepad=gamepad.RIGHT_TRIGGER, mouse=mouse.LEFT,
                    touch=touch.button("Strike", icon="sword", zone="primary", at=(0.893, 0.826), ring=Color.hex("#f6e4b6")))
    ability_1 = button(keyboard="KeyQ", gamepad=gamepad.RIGHT_SHOULDER,
                       touch=touch.button("Rune", icon="sparkles", at=(0.796, 0.656), cooldown=lambda ctx: spell_left(ctx, 1),
                                          enabled_when=lambda ctx: spell_ready(ctx, 1)))
    ability_2 = button(keyboard="KeyR", gamepad=gamepad.NORTH,
                       touch=touch.button("Mend", icon="heart", at=(0.858, 0.544), cooldown=lambda ctx: spell_left(ctx, 2),
                                          enabled_when=lambda ctx: spell_ready(ctx, 2)))
