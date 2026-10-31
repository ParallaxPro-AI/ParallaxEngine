"""Panels: the title card (as main menu, pause and result), the moves panel and the fight
HUD, ported from the original's chamfered title card and mirrored fight HUD. Each follows
the match phase and declares exactly the state it shows; buttons are plain functions from
game/menu_actions.py."""

import math

from parallax import Panel, Settings, SettingsPanel, close_panel, open_panel, reload_scene, ui
from parallax.combat import Health
from project import Content, Placed, Text

from game.actions import BoutControls, key_caps
from game.components import Corner, Fighter, FighterState
from game.menu_actions import (
    choose_dummy, continue_circuit, cycle_difficulty, fight_again, start_run, toggle_champion_kit,
    toggle_haptics, toggle_shake, toggle_sound,
)
from game.resources import Callout, CalloutStyle, Career, Dummy, Match, Mode, Phase, Preferences, RunStats
from game.rules import Rules, current_lesson, current_rival, difficulty, run_in_progress

MAIN_MENU = reload_scene(new_run=True)


def two(n: int) -> str:
    return f"{n:02d}"


def ladder(ctx, status_of) -> list[dict]:
    """The circuit's rungs for the ladder card; `status_of(i)` gives (label, css class)."""
    rows = []
    for i, rung in enumerate(ctx.config(Rules).ladder):
        status, kind = status_of(i)
        rows.append({
            "n": two(i + 1), "name": ctx.text(rung.data.name), "role": ctx.text(rung.data.role),
            "status": ctx.text(status), "done": kind == "done", "next": kind == "next",
            "belt": kind == "belt", "lost": kind == "lost",
        })
    return rows


def career_footer(ctx) -> dict:
    career = ctx.get(Career)
    return {
        "career_wins": career.wins,
        "belts": career.belts,
        "belts_label": ctx.text(Text.belt if career.belts == 1 else Text.belts),
        "best_rival": str(career.best_challenger) if career.best_challenger > 0 else "—",
        "champion": career.belts > 0,
    }


@ui("moves_panel", html="ui/moves.html", modal=True, layer="menu")
class MovesPanel(Panel):
    """"Make it your fight": difficulty, camera shake, sound and haptics, the keys (rebound
    in the engine's settings panel), the controller legend, the five rivals and, once a
    belt is won, the champion kit."""
    actions = {
        "close": close_panel(),
        "difficulty": cycle_difficulty,
        "shake": toggle_shake,
        "sound": toggle_sound,
        "haptics": toggle_haptics,
        "rebind": open_panel(SettingsPanel),
        "kit": toggle_champion_kit,
    }

    def state(self, ctx):
        settings = ctx.get(Settings)
        prefs = ctx.get(Preferences)
        order = ctx.config(Rules).difficulties
        caps = key_caps(ctx)
        return {
            "difficulty": ctx.text(difficulty(ctx).name),
            "difficulty_dots": [{"on": level == prefs.difficulty} for level in order],
            "shake_on": not settings.reduced_motion,
            "sound_on": settings.master_volume > 0,
            "haptics_on": prefs.haptics,
            "keys": [
                {"label": ctx.text(Text.key_light), "note": ctx.text(Text.key_light_note), "cap": caps["light"]},
                {"label": ctx.text(Text.key_heavy), "note": "", "cap": caps["heavy"]},
                {"label": ctx.text(Text.key_special), "note": ctx.text(Text.key_special_note), "cap": caps["bolt"]},
                {"label": ctx.text(Text.key_super), "note": ctx.text(Text.key_super_note), "cap": caps["super"]},
                {"label": ctx.text(Text.key_block), "note": ctx.text(Text.key_block_note), "cap": caps["guard"]},
            ],
            "five": [
                {"n": two(i + 1), "name": ctx.text(rung.data.name), "role": ctx.text(rung.data.role),
                 "taunt": ctx.text(rung.data.taunt)}
                for i, rung in enumerate(ctx.config(Rules).ladder)
            ],
            "champion": ctx.get(Career).belts > 0,
            "kit_on": prefs.champion_kit,
        }


@ui("title_screen", html="ui/title.html", modal=True, layer="menu",
    when=lambda ctx: not run_in_progress(ctx))
class TitleScreen(Panel):
    actions = {"start": start_run, "continue": continue_circuit, "moves": open_panel(MovesPanel)}

    def state(self, ctx):
        rules = ctx.config(Rules)
        checkpoint = ctx.get(Career).checkpoint

        def status(i):
            if checkpoint >= 0 and i < checkpoint:
                return Text.rung_beaten, "done"
            if checkpoint >= 0 and i == checkpoint:
                return Text.rung_next, "next"
            return Text.rung_open, ""

        return career_footer(ctx) | {
            "can_continue": checkpoint >= 0,
            "continue_label": ctx.text(Text.continue_at, n=checkpoint + 1) if checkpoint >= 0 else "",
            "continue_rival": ctx.text(rules.ladder[checkpoint].data.name) if checkpoint >= 0 else "",
            "rungs": ladder(ctx, status),
            "ladder_title": ctx.text(Text.ladder_title),
            "ladder_sub": ctx.text(Text.ladder_checkpoint, n=checkpoint + 1) if checkpoint >= 0
            else ctx.text(Text.ladder_sub),
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", toggle_with=BoutControls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "retry": fight_again, "main_menu": MAIN_MENU,
               "moves": open_panel(MovesPanel)}

    def state(self, ctx):
        match = ctx.get(Match)
        rival = ctx.text(current_rival(ctx).name).upper()
        if match.mode is Mode.CIRCUIT:
            where = ctx.text(Text.paused_circuit, round=match.round, seconds=math.ceil(match.clock), rival=rival)
            restart = ctx.text(Text.restart_vs, rival=ctx.text(current_rival(ctx).name))
        elif match.mode is Mode.TRAINING:
            lessons = len(ctx.config(Rules).lessons)
            where = ctx.text(Text.paused_training, n=min(match.lesson + 1, lessons), of=lessons)
            restart = ctx.text(Text.restart_tutorial)
        else:
            where = ctx.text(Text.paused_practice, rival=rival)
            restart = ctx.text(Text.restart_practice)
        return {"where": where, "restart": restart}


@ui("result_screen", html="ui/result.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Match).phase is Phase.OVER)
class ResultScreen(Panel):
    actions = {"start": start_run, "retry": fight_again, "main_menu": MAIN_MENU}

    def state(self, ctx):
        rules = ctx.config(Rules)
        match = ctx.get(Match)
        stats = ctx.get(RunStats)
        rungs = len(rules.ladder)
        training = match.mode is Mode.TRAINING
        won = stats.won and not training
        first = ctx.text(rules.ladder[0].data.name)
        rival = ctx.text(current_rival(ctx).name)

        def status(i):
            if won:
                return (Text.rung_belt, "belt") if i == rungs - 1 else (Text.rung_beaten, "done")
            if training:
                return (Text.rung_next, "next") if i == 0 else (Text.rung_open, "")
            if i < match.stage:
                return Text.rung_beaten, "done"
            if i == match.stage:
                return Text.rung_stopped, "lost"
            return Text.rung_open, ""

        if training:
            title, title_gold, desc = Text.over_training_1, Text.over_training_2, ctx.text(Text.over_training_desc, rival=first)
        elif won:
            title, title_gold, desc = Text.over_won_1, Text.over_won_2, ctx.text(Text.over_won_desc, rival=rival)
        else:
            title, title_gold, desc = Text.over_lost_1, Text.over_lost_2, ""
        tip = Text.tip_close_distance if stats.whiffs > stats.hits else Text.tip_punish_recovery
        footer = career_footer(ctx)
        return footer | {
            "title": ctx.text(title),
            "title_gold": ctx.text(title_gold),
            "desc": desc,
            "badge": footer["champion"] and won,
            "lost": not stats.won,
            "training": training,
            "tip": ctx.text(tip),
            "count_label": ctx.text(Text.res_lessons if training else Text.res_rivals),
            "count": len(rules.lessons) if training else (rungs if won else match.stage),
            "count_of": len(rules.lessons) if training else rungs,
            "hits": stats.hits,
            "blocks": stats.blocks,
            "punishes": stats.punishes,
            "best_combo": stats.best_combo,
            "fight_meta": ctx.text(Text.rival_n, rival=first, n=1),
            "retry_meta": "" if stats.won else ctx.text(Text.rival_n, rival=rival, n=match.stage + 1),
            "rungs": ladder(ctx, status),
            "ladder_title": ctx.text(Text.ladder_cleared if won else Text.ladder_title),
            "ladder_sub": ctx.text(Text.ladder_belt, n=footer["belts"]) if won
            else ctx.text(Text.ladder_sub) if training else ctx.text(Text.ladder_checkpoint, n=match.stage + 1),
        }


def corner(ctx, fighter, wins: int) -> dict:
    """One side of the HUD's mirrored top bar."""
    rules = ctx.config(Rules)
    data = fighter.get(Fighter)
    health = fighter.get(Health)
    super_cost = Content.move.circuit_breaker.data.meter_cost
    return {
        "hp": math.ceil(health.current),
        "health": f"{health.fraction * 100:.2f}%",
        "trail": f"{data.trail * 100:.2f}%",
        "spirit": f"{min(1.0, data.meter / rules.meter_max) * 100:.2f}%",
        "meter": int(data.meter),
        "super_ready": data.meter >= super_cost,
        "pips": [{"on": wins > i} for i in range(rules.rounds_to_win)],
    }


def banner(ctx, match) -> dict:
    """The band across the screen: the rival's intro, then how the round went."""
    rival = current_rival(ctx)
    if match.phase is Phase.INTRO:
        if match.mode is Mode.CIRCUIT:
            lead = two(match.stage + 1)
        else:
            lead = ctx.text(Text.mode_tutorial if match.mode is Mode.TRAINING else Text.mode_practice)
        return {"banner": True, "banner_role": f"{lead} · {ctx.text(rival.role)}", "banner_big": ctx.text(rival.name),
                "banner_tip": ctx.text(rival.taunt), "banner_won": False, "banner_rival": True}
    if match.phase is Phase.ROUND_OVER:
        timed = match.mode is Mode.CIRCUIT and match.timed_out
        if match.round_winner is Corner.CHALLENGER:
            big = Text.round_won
        elif match.round_winner is Corner.RIVAL:
            big = Text.round_lost
        else:
            big = Text.round_draw
        return {"banner": True, "banner_role": ctx.text(Text.round_complete_time if timed else Text.round_complete),
                "banner_big": ctx.text(big), "banner_tip": ctx.text(Text.round_tip),
                "banner_won": match.round_winner is Corner.CHALLENGER,
                "banner_rival": match.round_winner is Corner.RIVAL}
    return {"banner": False, "banner_role": "", "banner_big": "", "banner_tip": "", "banner_won": False,
            "banner_rival": False}


@ui("fight_hud", html="ui/hud.html")
class FightHud(Panel):
    actions = {"dummy": choose_dummy, "pause": open_panel(PauseMenu)}

    def state(self, ctx):
        rules = ctx.config(Rules)
        match = ctx.get(Match)
        you = ctx.world.placed(Placed.challenger)
        rival = ctx.world.placed(Placed.rival)
        circuit = match.mode is Mode.CIRCUIT
        bout = match.phase in (Phase.INTRO, Phase.FIGHT, Phase.ROUND_OVER)
        between = match.phase in (Phase.INTRO, Phase.ROUND_OVER)
        lessons = len(rules.lessons)
        in_lesson = match.mode is Mode.TRAINING and match.lesson < lessons and not between
        practice = match.mode is Mode.PRACTICE and not between
        lesson = current_lesson(ctx) if in_lesson else None
        callout = ctx.get(Callout)
        shown = callout.text if ctx.time.now < callout.until and not between else ""
        caps = key_caps(ctx)
        you_fighter = you.get(Fighter)
        super_ready = you_fighter.meter >= Content.move.circuit_breaker.data.meter_cost
        guarding = you_fighter.state is FighterState.BLOCKSTUN
        combo = rival.get(Fighter).hits_in_combo
        return {
            "bout": bout,
            "circuit": circuit,
            "you": corner(ctx, you, match.challenger_wins),
            "you_meter_label": ctx.text(Text.super_ready) if super_ready else f"{int(you_fighter.meter)} / {int(Content.move.circuit_breaker.data.meter_cost)}",
            "rival": corner(ctx, rival, match.rival_wins) | {"name": ctx.text(current_rival(ctx).name)},
            "round_label": ctx.text(Text.round_n, n=match.round),
            "clock": str(math.ceil(match.clock)) if circuit else "∞",
            "clock_inf": not circuit,
            "clock_low": circuit and match.phase is Phase.FIGHT and match.clock < 10,
            "rung": str(match.stage + 1),
            "rungs": str(len(rules.ladder)),
            "combo": combo if combo > 1 else 0,
            "notice": shown if callout.style is not CalloutStyle.LESSON else "",
            "notice_cyan": callout.style is CalloutStyle.CYAN,
            "notice_warn": callout.style is CalloutStyle.WARN,
            "toast": shown if callout.style is CalloutStyle.LESSON else "",
            "in_lesson": in_lesson,
            "lesson_step": f"{two(match.lesson + 1)} / {two(lessons)} · {ctx.text(lesson.title)}" if lesson else "",
            "lesson_hint": ctx.text(lesson.hint) if lesson else "",
            "lesson_verb": ctx.text(lesson.verb) if lesson else "",
            "lesson_key": (caps[lesson.key] if lesson.key in caps else lesson.key) if lesson else "",
            "lesson_progress": [{"done": i < match.lesson, "cur": i == match.lesson} for i in range(lessons)],
            "practice": practice,
            "dummy_idle": match.dummy is Dummy.IDLE,
            "dummy_guard": match.dummy is Dummy.GUARD,
            "dummy_spar": match.dummy is Dummy.SPAR,
            "dummy_desc": ctx.text(Text.dummy_spar_desc, difficulty=ctx.text(difficulty(ctx).name))
            if match.dummy is Dummy.SPAR else ctx.text(Text.dummy_guard_desc if match.dummy is Dummy.GUARD else Text.dummy_idle_desc),
            "has_bar": in_lesson or practice,
            "legend": [
                {"cap": caps["light"], "label": ctx.text(Text.legend_jab), "hl": False, "first": True},
                {"cap": caps["heavy"], "label": ctx.text(Text.legend_heavy), "hl": False, "first": False},
                {"cap": caps["bolt"], "label": ctx.text(Text.legend_bolt), "hl": False, "first": False},
                {"cap": caps["super"], "label": ctx.text(Text.legend_super), "hl": super_ready, "first": False},
                {"cap": caps["guard"], "label": ctx.text(Text.legend_guard), "hl": guarding and not super_ready,
                 "first": False},
            ],
        } | banner(ctx, match)
