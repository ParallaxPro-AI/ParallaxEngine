"""Drinking potions and opening the gear screen."""

from parallax import Actions, button, gamepad, touch

from project import Content

from features.inventory.resources import Bag


class InventoryControls(Actions):
    """F drinks the potion the hero needs most; I opens and closes the gear screen."""

    potion = button(keyboard="KeyF", gamepad=gamepad.LEFT_TRIGGER, touch=touch.button("Potion", icon="droplet", at=(0.936, 0.564),
                                                                                      enabled_when=lambda ctx: ctx.get(Bag).items.get(Content.item.health_potion, 0)
                                                                                      + ctx.get(Bag).items.get(Content.item.mana_potion, 0) > 0))
    gear = button(keyboard="KeyI", gamepad=gamepad.DPAD_UP)
