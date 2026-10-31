"""Title, HUD, hotbar and pause panels. The crafting, chest, furnace, death and
game-over panels live with their features."""

from parallax import Context, Panel, Settings, close_panel, load_scene, open_panel, ui
from parallax.combat import Health
from project import Scenes, Text

from features.creatures.feature import Siege
from features.inventory.feature import Equipment, Hotbar, Inventory, picture, stack_view, use_slot
from features.player.feature import Aim
from features.progress.feature import Lifetime, next_objective
from features.survival.feature import Run, Vitals
from game.actions import Controls
from game.config import Rules
from game.world import day_number, hearts, the_player


def continue_world(ctx: Context) -> None:
    """The title's Continue: load the saved world (the save names its scene)."""
    ctx.save.load("world")


def set_quality(ctx, value: str):
    """The pause card's graphics switch."""
    ctx.get(Settings).quality = value


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {
        "continue": continue_world,
        "new_world": load_scene(Scenes.greenwood, new_run=True),
        "challenge": load_scene(Scenes.greenwood, new_run=True, init=[Run(challenge=True)]),
    }

    def state(self, ctx):
        return {"has_save": ctx.save.exists("world"), "blocks_mined": ctx.get(Lifetime).blocks_mined}


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.greenwood],
    toggle_with=Controls.pause)
class PauseMenu(Panel):
    """Opening it saves the world (see Autosave), so Quit is a plain scene load."""

    actions = {"resume": close_panel(), "quit": load_scene(Scenes.title), "quality": set_quality}

    def state(self, ctx):
        current = ctx.get(Settings).quality
        return {"qualities": [
            {"value": q, "label": ctx.text(label), "pressed": "true" if q == current else "false"}
            for q, label in (("low", Text.quality_low), ("medium", Text.quality_medium), ("high", Text.quality_high))
        ]}


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        player = the_player(ctx)
        health = player.get(Health)
        vitals = player.get(Vitals)
        run = ctx.get(Run)
        rules = ctx.config(Rules)
        hour = ctx.environment.time_of_day
        lives = rules.lives - run.deaths
        return {
            "night": ctx.environment.is_night,
            "hurt": health.fraction < 0.25,
            "health_pct": f"{health.fraction * 100:.0f}%",
            "hunger_pct": f"{vitals.hunger / vitals.max_hunger * 100:.0f}%",
            "bubbles": [{"on": i < round(vitals.air / vitals.max_air * 5)} for i in range(5)],
            "siege_clock": f"{int(ctx.get(Siege).seconds_left) // 60}:{int(ctx.get(Siege).seconds_left) % 60:02d}",
            "coordinates": " / ".join(str(round(v)) for v in (player.transform.position.x, player.transform.position.y,
                                                             player.transform.position.z)),
            "hearts": hearts(rules.lives, lives),
            "health": round(health.current),
            "max_health": round(health.max),
            "health_fraction": health.fraction,
            "hunger": round(vitals.hunger),
            "hunger_fraction": vitals.hunger / vitals.max_hunger,
            "hunger_low": vitals.hunger < rules.hunger_warning,
            "air": round(vitals.air),
            "underwater": vitals.air < vitals.max_air,
            "day": day_number(ctx),
            "clock": f"{int(hour):02d}:{int(hour % 1 * 60):02d}",
            "objective": ctx.text(next_objective(ctx)),
            "tool": ctx.text(player.get(Equipment).tool.data.name),
            "siege_left": round(ctx.get(Siege).seconds_left),
            "challenge": run.challenge,
            "lives_left": rules.lives - run.deaths,
            **self._target(ctx, player.get(Aim)),
        }

    def _target(self, ctx, aim: Aim) -> dict:
        block = ctx.voxels.get(aim.cell) if aim.cell else None
        return {
            "target": ctx.text(block.data.name) if block else "",
            "target_usable": aim.cell is not None and ctx.voxels.block_entity(aim.cell) is not None,
            "mining": aim.progress,
            "mining_pct": f"{aim.progress * 100:.0f}%",
            "too_weak": ctx.text(Text.needs_stronger_tool, block=ctx.text(aim.too_weak_for.data.name))
                        if aim.too_weak_for else "",
        }


@ui("hotbar", html="ui/hotbar.html")
class HotbarPanel(Panel):
    actions = {"select": use_slot}

    def state(self, ctx):
        player = the_player(ctx)
        hotbar = player.get(Hotbar)
        slots = player.get(Inventory).slots[:hotbar.size]
        tool = player.get(Equipment).tool
        held = slots[hotbar.selected].item
        return {
            "tool": ctx.text(tool.data.name),
            "tool_picture": picture(tool),
            "selected_name": ctx.text(held.data.name) if held else ctx.text(Text.empty_hand),
            "slots": [stack_view(ctx, s, i, selected=i == hotbar.selected, hotbar=hotbar.size, equipped=tool)
                      for i, s in enumerate(slots)],
        }
