"""Panels: title, level select, HUD, pause and results, and the menu actions
that need logic (which level to load, the two profile toggles)."""

from parallax import ContentRef, Panel, Settings, close_panel, load_scene, open_panel, reload_scene, ui
from project import Scenes, Text

from game.actions import Controls
from game.components import Level, Player
from game.config import Rules
from game.content import LevelDef
from game.resources import Attempt, HubMenu, Mode, Profile

# Leaving a level lands on the level list, not the title.
back_to_levels = load_scene(Scenes.hub, new_run=True, init=[HubMenu(level_list=True)])


def play(ctx, level: ContentRef[LevelDef]):
    """Level list action: load the clicked level."""
    ctx.scenes.load(level.data.scene, new_run=True)


def next_level(ctx):
    """Results action: the level after this one; after the last, the level list."""
    following = ctx.content(LevelDef).next(ctx.get(Attempt).level)
    if following:
        play(ctx, following)
    else:
        ctx.scenes.load(Scenes.hub, new_run=True, init=[HubMenu(level_list=True)])


def show_levels(ctx):
    ctx.get(HubMenu).level_list = True


def hide_levels(ctx):
    ctx.get(HubMenu).level_list = False


def toggle_mode(ctx):
    profile = ctx.get(Profile)
    profile.mode = Mode.CHALLENGE if profile.mode is Mode.EXPLORE else Mode.EXPLORE


def toggle_sound(ctx):
    settings = ctx.get(Settings)
    settings.master_volume = 0.0 if settings.master_volume > 0 else 1.0


def toggle_shake(ctx):
    profile = ctx.get(Profile)
    profile.shake = not profile.shake


def clock(seconds: float) -> str:
    whole = max(0, int(seconds))
    return f"{whole // 60}:{whole % 60:02d}"


def star_row(earned: int) -> list[dict]:
    return [{"off": i >= earned} for i in range(3)]


def finished(ctx) -> bool:
    """The attempt was cleared or failed."""
    return ctx.get(Attempt).ended


@ui("level_select", html="ui/level_select.html", modal=True, layer="menu",
    scenes=[Scenes.hub], when=lambda ctx: ctx.get(HubMenu).level_list)
class LevelSelect(Panel):
    actions = {"play": play, "mode": toggle_mode, "back": hide_levels}

    def state(self, ctx):
        profile = ctx.get(Profile)
        levels = ctx.content(LevelDef)
        medals = sum(profile.stars.get(level, 0) for level in levels)
        rows = []
        for level in levels:
            stars, kept = profile.stars.get(level, 0), profile.keepsakes.get(level, 0)
            theme = level.data.theme
            rows.append({
                "level": level.id,
                "kicker": ctx.text(Text.destination, number=f"{level.data.order:02d}"),
                "numeral": f"{level.data.order:02d}",
                "theme": theme,
                "meadow": theme == "meadow", "crystal": theme == "crystal",
                "frost": theme == "frost", "ember": theme == "ember",
                "world": ctx.text(level.data.world),
                "name": ctx.text(level.data.name),
                "subtitle": ctx.text(level.data.subtitle),
                "par": ctx.text(Text.par_seconds, seconds=round(level.data.par_time)),
                "stars": star_row(stars),
                "complete": stars >= 3,
                "meta": (ctx.text(Text.atlas_meta, medals=stars, keepsakes=kept) if stars or kept
                         else ctx.text(Text.not_visited)),
            })
        return {
            "mode": "challenge" if profile.mode is Mode.CHALLENGE else "explore",
            "medals": ctx.text(Text.medals_of, medals=medals, total=3 * len(levels)),
            "medals_short": f"{medals} / {3 * len(levels)}",
            "levels": rows,
        }


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"start": show_levels}

    def state(self, ctx):
        profile = ctx.get(Profile)
        levels = ctx.content(LevelDef)
        cleared = sum(1 for level in levels if profile.stars.get(level, 0) > 0)
        medals = sum(profile.stars.get(level, 0) for level in levels)
        return {
            "first": "0" if cleared else "1",
            "worlds": [{"theme": level.data.theme if profile.stars.get(level, 0) else ""} for level in levels],
            "summary": ctx.text(Text.title_summary, cleared=cleared, total=len(levels), medals=medals,
                                max_medals=3 * len(levels)),
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Level], toggle_with=Controls.pause)
class PauseMenu(Panel):
    """Keep hopping, Restart island, Sky atlas, and the Sound / Camera shake switches."""
    actions = {
        "resume": close_panel(),
        "retry": reload_scene(new_run=True),
        "sound": toggle_sound,
        "shake": toggle_shake,
        "quit": back_to_levels,
    }

    def state(self, ctx):
        sound, shake = ctx.get(Settings).master_volume > 0, ctx.get(Profile).shake
        return {
            "sound_checked": "true" if sound else "false",
            "sound_label": ctx.text(Text.on if sound else Text.off),
            "shake_checked": "true" if shake else "false",
            "shake_label": ctx.text(Text.on if shake else Text.off),
        }


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        attempt = ctx.get(Attempt)
        level = attempt.level.data
        x = ctx.world.query(tagged=Player).single().transform.position.x
        progress = min(1.0, max(0.0, x / level.length))
        section = level.sections[min(len(level.sections) - 1, int(progress * len(level.sections)))]
        challenge = ctx.get(Profile).mode is Mode.CHALLENGE
        elapsed = ctx.time.now - attempt.started_at
        rules = ctx.config(Rules)
        return {
            "mode": "challenge" if challenge else "explore",
            "dead": "1" if attempt.dead else "0",
            "level": ctx.text(level.name),
            "level_number": ctx.text(Text.level_number, number=level.order),
            "banner": elapsed < 3,
            "section": ctx.text(section),
            "progress_pct": f"{round(progress * 100)}%",
            "score": attempt.score,
            "coins": attempt.coins,
            "chain": f"×{attempt.chain:.1f}",
            "chain_live": attempt.chain > 1,
            "lives": attempt.lives,
            "hearts": [{"off": i >= attempt.lives} for i in range(max(rules.max_lives, attempt.lives))],
            "keepsakes": f"{attempt.keepsakes} / {attempt.keepsakes_total}",
            "keepsakes_short": f"{attempt.keepsakes}/{attempt.keepsakes_total}",
            "time": clock(elapsed),
            "par_label": ctx.text(Text.par_seconds, seconds=round(level.par_time)),
            "notice": attempt.notice if ctx.time.now < attempt.notice_until else "",
        }


@ui("results", html="ui/results.html", modal=True, layer="menu", when=finished)
class Results(Panel):
    actions = {
        "next": next_level,
        "replay": reload_scene(new_run=True),
        "quit": back_to_levels,
    }

    def state(self, ctx):
        attempt = ctx.get(Attempt)
        level = attempt.level.data
        following = ctx.content(LevelDef).next(attempt.level)
        final = attempt.won and following is None
        name = ctx.text(level.name)
        if not attempt.won:
            title, tag = Text.results_failed, ctx.text(Text.results_failed_tag, level=name)
        elif final:
            title, tag = Text.results_final, ctx.text(Text.results_final_tag, level=name)
        else:
            title, tag = Text.results_clear, name
        earned = attempt.stars if attempt.won else 0
        if attempt.won:
            time_label = (ctx.text(Text.results_under_par, bonus=attempt.time_bonus) if attempt.time_bonus > 0
                          else ctx.text(Text.results_over_par) if attempt.time > level.par_time
                          else ctx.text(Text.results_time))
            last = [(time_label, clock(attempt.time), attempt.time_bonus > 0),
                    (ctx.text(Text.results_retries), str(attempt.deaths), False)]
        else:
            last = [(ctx.text(Text.hud_coins), str(attempt.coins), False),
                    (ctx.text(Text.results_lives_left), str(attempt.lives), False)]
        stats = [(ctx.text(Text.hud_keepsakes_label), f"{attempt.keepsakes}/3", False),
                 (ctx.text(Text.results_score), f"{attempt.score:,}", False)] + last
        return {
            "outcome": "win" if attempt.won else "lose",
            "theme": level.theme,
            "tag": tag,
            "title": ctx.text(title),
            "stars": [{"cls": f"sh-ico sh-star s{i + 1}" + ("" if i < earned else " off")} for i in range(3)],
            "stats": [{"label": label, "value": value, "positive": positive} for label, value, positive in stats],
            "has_next": attempt.won and following is not None,
            "replay_primary": not (attempt.won and following is not None) and not final,
            "atlas_primary": final,
            "new_best": attempt.new_best,
            "best": f"{ctx.get(Profile).best.get(attempt.level, 0):,}",
        }
