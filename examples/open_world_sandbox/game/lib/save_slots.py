"""Save slots menu (library piece `save_slots`).

The save plugin does the saving and keeps what a menu shows about each slot
(`ctx.save.info(slot)`: scene, play time, label, order), so this piece is only the panel:
a row per configured slot, "latest" on the slot saved last. Saving is offered only in
playable scenes — the title screen can load and delete but has nothing to save. The menu is
modal; Load closes it by loading the slot's scene."""

from parallax import Panel, close_panel, config, field, ui

from game.lib.scene_tags import Playable


@config("save_slots")
class SaveSlotsConfig:
    """config/save_slots.json."""
    slots: list[str] = field(["slot_1", "slot_2", "slot_3"])


def save_slot(ctx, slot: str):
    if ctx.scenes.current_is(Playable):
        ctx.save.save(slot)


def load_slot(ctx, slot: str):
    ctx.save.load(slot)


def delete_slot(ctx, slot: str):
    ctx.save.delete(slot)


@ui("save_slots", html="ui/lib/save_slots.html", modal=True, layer="menu")
class SaveSlots(Panel):
    actions = {"save": save_slot, "load": load_slot, "delete": delete_slot, "back": close_panel()}

    def state(self, ctx):
        can_save = ctx.scenes.current_is(Playable)
        names = ctx.config(SaveSlotsConfig).slots
        infos = [ctx.save.info(slot) for slot in names]
        latest = max([info.order for info in infos if info is not None], default=0)
        rows = []
        for i, slot in enumerate(names):
            info = infos[i]
            rows.append({
                "slot": slot,
                "number": i + 1,
                "used": info is not None,
                "scene": info.scene.id if info is not None else "",
                "label": info.label if info is not None else "",
                "play_seconds": info.play_time if info is not None else 0.0,
                "latest": info is not None and info.order == latest,
                "can_save": can_save,
            })
        return {"slots": rows, "can_save": can_save}
