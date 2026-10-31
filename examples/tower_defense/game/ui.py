"""Panels: title, campaign map, HUD, pause menu and result screen, ported from the
template's war-table kit. Each one opens from state or input; no system opens or closes
a panel."""

import math

from parallax import Panel, close_panel, open_panel, ui
from project import Scenes, Text

from game.actions import SiegeControls
from game.battlefield_map import battle, enter_level, is_unlocked
from game.behaviors.overview_camera import recenter
from game.components import BattlefieldScene, Invader, Turret
from game.config import SiegeRules
from game.construction import cancel_build, choose_tower, sell_tower, upgrade_tower
from game.content import LevelDef, TowerDef
from game.events import WaveStartRequested
from game.resources import Build, Campaign, Menu, Purse, Result, Siege
from game.siege import current_level, sell_value, stats, tower_on, wave_in_progress


def quit_to_title(ctx):
    """Exit to Menu / Main Menu: back to the title over the campaign map's table."""
    ctx.get(Menu).title_seen = False
    ctx.scenes.load(Scenes.level_select, new_run=True)


def css(color) -> str:
    return f"rgb({round(color.r * 255)}, {round(color.g * 255)}, {round(color.b * 255)})"


def star_text(stars: int) -> str:
    return "★" * stars + "☆" * max(0, 3 - stars)


def start_siege(ctx):
    """The title's Start Siege: on to the campaign map."""
    ctx.get(Menu).title_seen = True


def back_to_title(ctx):
    ctx.get(Menu).title_seen = False


@ui("title_screen", html="ui/title.html", layer="menu", scenes=[Scenes.level_select],
    when=lambda ctx: not ctx.get(Menu).title_seen)
class TitleScreen(Panel):
    actions = {"start": start_siege}


@ui("level_select", html="ui/level_select.html", layer="menu", scenes=[Scenes.level_select],
    when=lambda ctx: ctx.get(Menu).title_seen)
class LevelSelect(Panel):
    """Four chapter cards; a card goes straight into its battlefield."""

    actions = {"enter": enter_level, "back": back_to_title}

    def state(self, ctx):
        campaign = ctx.get(Campaign)
        return {
            "levels": [
                {
                    "level": level.id,
                    "chapter": ctx.text(Text.chapter, number=level.data.number),
                    "name": ctx.text(level.data.name),
                    "tagline": ctx.text(level.data.tagline),
                    "land": css(level.data.land),
                    "waves": len(level.data.waves),
                    "stars": star_text(campaign.stars.get(level, 0)),
                    "locked": not is_unlocked(ctx, level),
                    "cta": (ctx.text(Text.unlock_hint, number=level.data.number - 1) if not is_unlocked(ctx, level)
                            else ctx.text(Text.enter_battlefield)),
                }
                for level in ctx.content(LevelDef)
            ],
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[BattlefieldScene],
    toggle_with=SiegeControls.pause)
class PauseMenu(Panel):
    """PAUSED, Resume and Exit to Menu, as the template's pause card."""

    actions = {"resume": close_panel(), "quit": quit_to_title}


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {
        "choose_tower": choose_tower,
        "upgrade": upgrade_tower,
        "sell": sell_tower,
        "cancel": cancel_build,
        "send_wave": WaveStartRequested,
        "pause": open_panel(PauseMenu),
        "camera_home": recenter,
    }

    def state(self, ctx):
        level = current_level(ctx)
        purse, siege, build = ctx.get(Purse), ctx.get(Siege), ctx.get(Build)
        upcoming = level.waves[siege.wave].data if siege.wave < len(level.waves) else None
        rules = ctx.config(SiegeRules)
        marching = wave_in_progress(ctx)
        interest = min(rules.interest_cap, math.floor(purse.gold * rules.interest_rate))
        boss_next = upcoming is not None and upcoming.boss
        if marching:
            send_label, status = ctx.text(Text.wave_in_progress), ctx.text(
                Text.afield, count=ctx.world.query(Invader).count())
        elif upcoming is None:
            send_label, status = ctx.text(Text.wave_in_progress), ""
        else:
            send_label = ctx.text(Text.send_boss_wave if boss_next
                                  else Text.start_first_wave if siege.wave == 0 else Text.start_next_wave)
            status = ctx.text(Text.build_phase)
        armed = build.armed
        selected = self.selected_tower(ctx, build)
        state = {
            "gold": purse.gold,
            "interest_text": f"+{interest}g" if interest > 0 and not marching else "",
            "lives": purse.lives,
            "lives_critical": purse.lives <= 5,
            "wave": siege.wave,
            "wave_count": len(level.waves),
            "wave_status": status,
            "send_label": send_label,
            "cannot_send": upcoming is None or marching,
            "boss_next": boss_next,
            "intel_title": ctx.text(Text.boss_incoming if boss_next else Text.next_wave),
            "intel": [] if upcoming is None or marching else [
                {"name": ctx.text(group.enemy.data.name), "count": group.count} for group in upcoming.groups
            ],
            "armed": armed is not None,
            "hint_desktop": (ctx.text(Text.placing_desktop, tower=ctx.text(armed.data.name)) if armed
                             else ctx.text(Text.build_hint_desktop)),
            "hint_touch": (ctx.text(Text.placing_touch, tower=ctx.text(armed.data.name)) if armed
                           else ctx.text(Text.build_hint_touch)),
            "palette": [
                {
                    "tower": tower.id,
                    "slot": tower.data.slot,
                    "name": ctx.text(tower.data.name),
                    "brief": f"{stats(tower, 1).range:g}m · {ctx.text(tower.data.role)}",
                    "accent": tower.data.accent,
                    "cost": stats(tower, 1).cost,
                    "unaffordable": purse.gold < stats(tower, 1).cost,
                    "armed": tower == armed,
                }
                for tower in ctx.content(TowerDef)
            ],
            "selected": selected is not None,
            "show_hint": selected is None,
        }
        state.update(selected or {"spot_detail": "", "maxed": True, "upgrade_cost": 0, "sell_value": 0})
        return state

    def selected_tower(self, ctx, build):
        tower = tower_on(build.selected) if build.selected is not None else None
        if tower is None:
            return None
        turret = tower.get(Turret)
        current = stats(turret.kind, turret.level)
        maxed = turret.level == len(turret.kind.data.levels)
        return {
            "spot_detail": ctx.text(Text.spot_detail, tower=ctx.text(turret.kind.data.name), tier=turret.level,
                                    damage=current.damage, range=f"{current.range:g}"),
            "maxed": maxed,
            "upgrade_cost": 0 if maxed else stats(turret.kind, turret.level + 1).cost,
            "sell_value": sell_value(ctx, turret),
        }


@ui("result_screen", html="ui/result.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Siege).result is not Result.PLAYING)
class ResultScreen(Panel):
    actions = {"retry": battle, "quit": quit_to_title}

    def state(self, ctx):
        siege, purse = ctx.get(Siege), ctx.get(Purse)
        level = current_level(ctx)
        won = siege.result is Result.WON
        waves = f"{siege.wave} / {len(level.waves)}"
        if won:
            levels = ctx.content(LevelDef)
            last = level.number >= len(levels)
            headline = ctx.text(Text.campaign_complete if last else Text.victory)
            stats_rows = [(Text.waves_cleared, waves), (Text.rating, star_text(siege.stars)),
                          (Text.lives_remaining, str(purse.lives)), (Text.gold_banked, str(purse.gold)),
                          (Text.battlefield, ctx.text(level.name))]
            if not last:
                stats_rows.append((Text.unlocked, ctx.text(levels[level.number].data.name)))
        else:
            headline = ctx.text(Text.defeat)
            stats_rows = [(Text.reached_wave, waves), (Text.battlefield, ctx.text(level.name))]
        return {
            "headline": headline,
            "won": won,
            "lost": not won,
            "score": siege.score if won else 0,
            "stats": [{"label": ctx.text(label), "value": value} for label, value in stats_rows],
        }
