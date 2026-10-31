"""Panels: title, shrine, HUD, the level-up draft, pause and the end of the run, drawn in the
template's ember kit (ui/ember.css). Buttons are panel commands or plain functions
(game/shrine.py, game/systems/leveling.py)."""

from parallax import Panel, SettingsPanel, close_panel, load_scene, open_panel, ui
from parallax.combat import Health
from project import Scenes, Text

from game.actions import Controls
from game.components import Build, Elite, Horde
from game.content import PerkDef, SurgeDef, Tier
from game.horde import current_surge
from game.resources import Choices, Draft, Outcome, Records, Run
from game.rules import Rules, survivor, vigil_unlocked, xp_to_level
from game.shrine import buy_perk, light_circle, perk_cost, toggle_vigil
from game.systems.leveling import pick_upgrade, reroll

DASH_SECONDS = 0.2
"""How long the dash row reads DASH after a press (the burst itself)."""


def percent(fraction: float) -> str:
    """A CSS width for a 0..1 fill."""
    return f"{max(0.0, min(1.0, fraction)) * 100:.1f}%"


def clock(seconds: float) -> str:
    """m:ss, as the template's ember clock shows it."""
    whole = max(0, int(seconds))
    return f"{whole // 60}:{whole % 60:02d}"


def one_decimal(value: float) -> str:
    return f"{value:.1f}"


def time_left(ctx) -> float:
    return ctx.config(Rules).run_seconds - ctx.time.scene_time


@ui("shrine", html="ui/shrine.html", modal=True, layer="menu")
class ShrinePanel(Panel):
    actions = {"buy": buy_perk, "close": close_panel()}

    def state(self, ctx):
        records = ctx.get(Records)
        perks = []
        for perk in ctx.content(PerkDef):
            level = records.perk_levels.get(perk, 0)
            cost = perk_cost(perk.data, level)
            maxed = level == perk.data.max_level
            perks.append({
                "perk": perk.id,
                "name": ctx.text(perk.data.name),
                "desc": ctx.text(perk.data.desc),
                "level": level,
                "max_level": perk.data.max_level,
                "pips": [{"filled": n < level} for n in range(perk.data.max_level)],
                "cost": f"{cost:,}",
                "maxed": maxed,
                "affordable": not maxed and records.dust >= cost,
                "poor": not maxed and records.dust < cost,
            })
        return {"dust": f"{records.dust:,}", "perks": perks}


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"start": light_circle, "vigil": toggle_vigil, "shrine": open_panel(ShrinePanel)}

    def state(self, ctx):
        records = ctx.get(Records)
        unlocked = vigil_unlocked(ctx)
        lit = unlocked and ctx.get(Choices).vigil
        return {
            "dust": f"{records.dust:,}",
            "has_best": records.best_score > 0,
            "best_seconds": f"{records.best_seconds}s",
            "best_score": f"{records.best_score:,}",
            "vigil_locked": not unlocked,
            "vigil_off": unlocked and not lit,
            "vigil_lit": lit,
            "seed_placeholder": ctx.text(Text.seed_last, seed=records.last_seed) if records.last_seed
            else ctx.text(Text.seed_random),
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu",
    scenes=[Scenes.arena], toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "settings": open_panel(SettingsPanel),
               "main_menu": load_scene(Scenes.title, new_run=True)}

    def state(self, ctx):
        return {"clock": clock(time_left(ctx)), "tier": ctx.text(current_surge(ctx).name)}


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        hero = survivor(ctx)
        build = hero.get(Build)
        health = hero.get(Health)
        now = ctx.time.now
        nova_left = max(0.0, build.nova_ready_at - now)
        dash_left = max(0.0, build.dash_ready_at - now)
        dashing = now - (build.dash_ready_at - build.dash_cooldown) < DASH_SECONDS
        wardens = [health for _, health in ctx.world.query(Health, tagged=Elite) if health.current > 0]
        warden = sum(h.current for h in wardens) / sum(h.max for h in wardens) if wardens else 0
        chain = 1 - (now - run.last_kill_at) / rules.combo_window if run.combo > 1 else 0
        if dashing:
            dash_state = Text.dashing
        elif dash_left == 0:
            dash_state = Text.ready
        else:
            dash_state = Text.recharging
        return {
            "clock": clock(time_left(ctx)),
            "tier": ctx.text(current_surge(ctx).name),
            "run_width": percent(now / rules.run_seconds),
            "tier_marks": [{"left": percent(s.data.at_second / rules.run_seconds)}
                           for s in ctx.content(SurgeDef) if 0 < s.data.at_second < rules.run_seconds],
            "level": run.level,
            "swarm": ctx.world.query(tagged=Horde).count(),
            "kills": f"{run.kills:,}",
            "vigil": ctx.get(Choices).vigil,
            "warden": bool(wardens),
            "warden_pct": f"{round(warden * 100)}%",
            "warden_width": percent(warden),
            "seed": ctx.seed,
            "chained": run.combo > 1,
            "combo": f"×{one_decimal(run.combo)}",
            "chain_width": percent(chain),
            "hp": int(health.current),
            "hp_max": round(health.max),
            "hp_width": percent(health.fraction),
            "low": 0 < health.fraction < 0.25,
            "xp_width": percent(run.xp / xp_to_level(ctx)),
            "nova_width": percent(1 - nova_left / build.nova_cooldown),
            "charging": nova_left > 0,
            "nova_left": f"{one_decimal(nova_left)}s",
            "dash_width": percent(1 - dash_left / build.dash_cooldown),
            "dash_ready": dash_left == 0,
            "dash_state": ctx.text(dash_state),
            "score": f"{int(run.score):,}",
            "revives": build.revives,
            "rerolls": ctx.get(Draft).rerolls,
            "alert": run.alert if now < run.alert_until else "",
        }


@ui("level_up_draft", html="ui/draft.html", modal=True, layer="overlay",
    when=lambda ctx: bool(ctx.get(Draft).cards))
class DraftPanel(Panel):
    actions = {"pick": pick_upgrade, "reroll": reroll}

    def state(self, ctx):
        draft = ctx.get(Draft)
        cards = []
        for number, card in enumerate(draft.cards, start=1):
            owned = draft.stacks.get(card, 0)
            rare = card.data.tier is Tier.RARE
            cards.append({
                "upgrade": card.id,
                "number": number,
                "name": ctx.text(card.data.name),
                "desc": ctx.text(card.data.desc),
                "owned": ctx.text(Text.owned, count=owned) if owned else "",
                "glyph": card.data.icon,
                "rare": rare,
                "rarity": ctx.text(Text.rare if rare else Text.common),
            })
        return {"level": ctx.get(Run).level, "rerolls": draft.rerolls, "no_rerolls": draft.rerolls == 0,
                "cards": cards}


@ui("run_over", html="ui/run_over.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Run).outcome is not None)
class RunOverPanel(Panel):
    actions = {"again": load_scene(Scenes.arena, new_run=True), "title": load_scene(Scenes.title, new_run=True)}

    def state(self, ctx):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        records = ctx.get(Records)
        return {
            "survived": run.outcome is Outcome.SURVIVED,
            "fell": run.outcome is Outcome.FELL,
            "score": f"{int(run.score):,}",
            "seconds": f"{int(min(ctx.time.scene_time, rules.run_seconds))}s",
            "run_seconds": f"{int(rules.run_seconds)}s",
            "level": run.level,
            "kills": f"{run.kills:,}",
            "dust": f"+{run.dust_earned}",
            "seed": ctx.seed,
            "vigil": ctx.get(Choices).vigil,
            "new_best": run.new_best,
            "best": f"{records.best_score:,}",
        }
