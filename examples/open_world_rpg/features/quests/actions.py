"""Talking to people and opening the journal."""

from parallax import Actions, Color, button, gamepad, touch

from features.quests.resources import Focus


class QuestControls(Actions):
    """E talks to whoever is within reach; H opens and closes the journal."""

    interact = button(keyboard="KeyE", gamepad=gamepad.WEST, touch=touch.button("Talk", icon="hand", at=(0.723, 0.672), size=1.04,
                                                                               ring=Color.hex("#e0c48c"),
                                                                               visible_when=lambda ctx: ctx.get(Focus).npc is not None))
    journal = button(keyboard="KeyH", gamepad=gamepad.SELECT)
