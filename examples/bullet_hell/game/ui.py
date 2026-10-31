"""Panels. The title and HUD are listed by their scenes; pause and the result card
exist only in the garden, and the modals follow state."""

from collections import Counter

from parallax import (
    Panel, SettingsPanel, close_panel, load_scene, open_panel, reload_scene, ui,
)
from parallax.combat import Health
from project import Scenes, Text

from game.actions import Controls
from game.build import current_wave, find_wisp, run_over, stacks
from game.components import Guardian, Wisp
from game.config import Build
from game.content import Gun, WaveDef
from game.events import UpgradePicked
from game.glyphs import GLYPHS
from game.resources import Banner, Best, Chain, Run, Shrine


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"start": load_scene(Scenes.garden, new_run=True)}

    def state(self, ctx):
        best = ctx.get(Best)
        return {
            "has_records": best.score > 0 or best.runs > 0,
            "best_score": f"{best.score:,}",
            "best_wave": best.wave,
            "victories": best.victories,
            "victories_label": ctx.text(Text.victory if best.victories == 1 else Text.victories),
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.garden],
    toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {
        "resume": close_panel(),
        "settings": open_panel(SettingsPanel),
        "quit": load_scene(Scenes.title),
    }


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        run = ctx.get(Run)
        chain = ctx.get(Chain)
        wisp_entity = find_wisp(ctx)
        wisp = wisp_entity.get(Wisp)
        health = wisp_entity.get(Health)
        boss = find_boss(ctx)
        waves = ctx.content(WaveDef)
        spirit = wisp.spirit / ctx.config(Build).spirit_max
        lives = int(health.current)
        shown = ctx.get(Banner)
        return {
            "score_text": f"{run.score:,}",
            "chain": chain.kills,
            "multiplier": chain.multiplier,
            "wave": run.wave_index + 1,
            "waves": len(waves),
            "wave_name": ctx.text(current_wave(ctx).data.name),
            "acts": act_pips(waves, run.wave_index),
            "hearts": [{"on": i < lives} for i in range(int(health.max))],
            "last_petal": lives == 1,
            "shields": int(health.shield),
            "bombs": wisp.bombs,
            "max_bombs": int(wisp.max_bombs),
            "no_bombs": wisp.bombs == 0,
            "spirit_css": percent(spirit),
            "spirit_pct": "FULL" if spirit >= 1 else f"{round(spirit * 100)}%",
            "spirit_full": spirit >= 1,
            "graze": f"{run.graze:,}",
            "has_gun": wisp.gun is not Gun.SINGLE,
            "gun": ctx.text(GUN_NAMES[wisp.gun]),
            "gun_seconds": f"{wisp.gun_time.remaining:.1f}s",
            "gun_css": percent(0 if wisp.gun_time.done else 1 - wisp.gun_time.progress),
            "focusing": wisp.focusing,
            "has_boss": boss is not None,
            "boss_name": ctx.text(boss.get(Guardian).kind.data.name) if boss else "",
            "boss_hp": max(0, int(boss.get(Health).current)) if boss else 0,
            "boss_max": int(boss.get(Health).max) if boss else 0,
            "boss_css": percent(boss.get(Health).fraction) if boss else "0%",
            "banner_on": not shown.timer.done,
            "banner": {
                "kick": shown.kick, "title": shown.title,
                "caps": shown.kind not in ("wave", "warn"),
                "wave": shown.kind == "wave", "warn": shown.kind == "warn",
                "spirit": shown.kind == "spirit", "bloom": shown.kind == "bloom",
                "pickup": shown.kind == "pickup", "empty": shown.kind == "empty",
            },
        }


def percent(fraction: float) -> str:
    """A 0..1 fill as the CSS length the HUD's gauges read ("42.0%")."""
    return f"{max(0.0, min(1.0, fraction)) * 100:.1f}%"


def act_pips(waves, current: int) -> list[dict]:
    """The waves as act groups of pips (3·3·3); the boss wave's pip is a diamond."""
    acts = []
    for i, w in enumerate(waves):
        if i == 0 or w.data.act != waves[i - 1].data.act:
            acts.append({"pips": []})
        acts[-1]["pips"].append({"done": i < current, "now": i == current,
                                 "boss": w.data.guardian.data.boss})
    return acts


@ui("shrine", html="ui/shrine.html", modal=True, layer="menu",
    when=lambda ctx: bool(ctx.get(Shrine).offer))
class ShrinePanel(Panel):
    actions = {"choose": UpgradePicked}

    def state(self, ctx):
        run = ctx.get(Run)
        upcoming = ctx.content(WaveDef)[run.wave_index + 1].data
        return {
            "subtitle": ctx.text(Text.wave_cleared, number=run.waves_cleared,
                                 next=ctx.text(upcoming.name)),
            "options": [shrine_card(ctx, u) for u in ctx.get(Shrine).offer],
            "build": [
                {"name": ctx.text(u.data.name), "stacked": n > 1, "times": f"×{n}", "dot": i > 0}
                for i, (u, n) in enumerate(Counter(ctx.get(Shrine).taken).items())
            ],
        }


def shrine_card(ctx, upgrade) -> dict:
    """One attunement card: its glyph, the stacks owned / the one this pick adds / the
    rest, and the level after taking it (or MAXED)."""
    have = stacks(ctx, upgrade)
    top = upgrade.data.max_stacks
    maxed = have >= top
    return {
        "upgrade": upgrade.id,
        "name": ctx.text(upgrade.data.name),
        "description": ctx.text(upgrade.data.description),
        "glyph": GLYPHS.get(upgrade.id, GLYPHS["quickpetal"]),
        "own": [{} for _ in range(have)],
        "gain": [] if maxed else [{}],
        "rest": [{} for _ in range(max(0, top - have - 1))],
        "maxed": maxed,
        "level": f"MAXED {top}/{top}" if maxed else f"{have + 1}/{top}",
    }


@ui("result", html="ui/result.html", modal=True, layer="menu", scenes=[Scenes.garden],
    when=run_over)
class ResultPanel(Panel):
    actions = {"retry": reload_scene(new_run=True), "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        run = ctx.get(Run)
        return {
            "lost": not run.won,
            "title": ctx.text(Text.garden_stilled if run.won else Text.wisp_fades),
            "subtitle": (ctx.text(Text.thornmother_undone) if run.won
                         else ctx.text(Text.fell_on_wave, number=run.wave_index + 1,
                                       total=len(ctx.content(WaveDef)))),
            "score": run.score,
            "score_text": f"{run.score:,}",
            "new_best": run.new_best,
            "waves": run.waves_cleared,
            "graze": f"{run.graze:,}",
            "best": f"{ctx.get(Best).score:,}",
            "build": [{"label": label} for label in build_labels(ctx)],
        }


GUN_NAMES = {Gun.SINGLE: Text.gun_single, Gun.SPREAD: Text.gun_spread,
             Gun.RAPID: Text.gun_rapid, Gun.PIERCE: Text.gun_pierce}


def build_labels(ctx) -> list[str]:
    """The attunements taken, e.g. ["Quickpetal ×2", "Twin Bud"]."""
    counts = Counter(ctx.get(Shrine).taken)
    return [ctx.text(u.data.name) + (f" ×{n}" if n > 1 else "") for u, n in counts.items()]


def find_boss(ctx):
    """The boss guardian on the field, if any."""
    bosses = ctx.world.query(Guardian).where(lambda _, guardian: guardian.kind.data.boss).entities()
    return bosses[0] if bosses else None
