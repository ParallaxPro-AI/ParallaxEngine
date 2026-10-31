"""Panels: title, pause, HUD and results, the template's terminal-kit panels (ui/kit.css).
Every button is a built-in panel command; the results panel follows the firewall
(`lives_left == 0`). Pause and results exist only on the grid (`scenes=`)."""

from parallax import Context, Panel, Vec2, SettingsPanel, close_panel, load_scene, open_panel, reload_scene, ui
from project import Scenes, Text

from game.actions import Controls
from game.components import Word
from game.config import Rules
from game.resources import Records, Run
from game.rules import accuracy, field_point, grade, lives_left, threat, wpm
from game.systems.judge import type_key

# How long the HUD's one-shot animations run (their CSS durations), in seconds.
ERROR_SHAKE = 0.14
COMBO_BUMP = 0.26
MILESTONE_STAMP = 2.2
SCORE_POP = 0.9

KEYBOARD_ROWS = ("qwertyuiop", "asdfghjkl", "zxcvbnm")


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"play": load_scene(Scenes.grid, new_run=True)}

    def state(self, ctx):
        records = ctx.get(Records)
        return {"has_best": records.best_score > 0, "best_score": f"{records.best_score:,}",
                "best_wpm": f"{records.best_wpm:,}"}


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.grid],
    toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {
        "resume": close_panel(),
        "settings": open_panel(SettingsPanel),
        "quit": load_scene(Scenes.title),
    }


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu), "press": type_key}

    def state(self, ctx):
        run = ctx.get(Run)
        rules = ctx.config(Rules)
        now = ctx.time.now
        lives = lives_left(ctx)
        return {
            "time": ctx.time.scene_time,
            "score": f"{run.score:,}",
            "combo": run.combo,
            "show_combo": run.combo >= rules.show_combo_from,
            "combo_bump": run.combo >= rules.show_combo_from and now - run.cleared_at < COMBO_BUMP,
            "notice": ctx.text(Text.combo_milestone, combo=run.milestone),
            "notice_on": now - run.milestone_at < MILESTONE_STAMP,
            "wpm": wpm(ctx),
            "accuracy": round(accuracy(run) * 100),
            "grade": grade(ctx),
            "lives": lives,
            "max_lives": rules.lives,
            "pips": [{"gone": i >= lives} for i in range(rules.lives)],
            "danger": lives <= rules.low_lives,
            "threat": threat(ctx),
            "threat_width": f"{threat(ctx) * 100:.1f}%",
            "words": falling_words(ctx),
            **keyboard(ctx),
            "pops": [{"on": now - pop.time < SCORE_POP, "points": f"+{pop.points:,}",
                      "cipher": pop.kind.id == "cipher", "breach": pop.kind.id == "breach",
                      **field_style(pop.at)} for pop in run.pops],
            "cleared": run.cleared,
            "breached": run.breached,
            "best": f"{ctx.get(Records).best_score:,}",
        }


@ui("results_panel", html="ui/results.html", modal=True, layer="menu", scenes=[Scenes.grid],
    when=lambda ctx: lives_left(ctx) == 0)
class ResultsPanel(Panel):
    actions = {"retry": reload_scene(new_run=True), "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        run = ctx.get(Run)
        return {
            "grade": grade(ctx),
            "survived": ctx.time.scene_time,
            "score": f"{run.score:,}",
            "wpm": wpm(ctx),
            "accuracy": f"{accuracy(run) * 100:.1f}",
            "max_combo": run.max_combo,
            "cleared": run.cleared,
            "breached": run.breached,
            "best": f"{ctx.get(Records).best_score:,}",
            "new_best": run.new_best,
        }


def falling_words(ctx: Context) -> list[dict]:
    """The HUD's word chips: each word's letters split at the cursor, its kind, and where
    it sits on the word field. The locked target shakes red for a moment after a wrong key."""
    run = ctx.get(Run)
    shaking = ctx.time.now - run.missed_at < ERROR_SHAKE
    chips = []
    for entity, word in ctx.world.query(Word).to_list():
        target = entity == run.target
        chips.append({
            "text": word.text,
            "done": word.text[:word.typed],
            "next": word.text[word.typed:word.typed + 1],
            "rest": word.text[word.typed + 1:],
            "target": target,
            "error": target and shaking,
            "cipher": word.kind.id == "cipher",
            "breach": word.kind.id == "breach",
            **field_style(field_point(ctx, entity.transform.position)),
        })
    return chips


def field_style(at: Vec2) -> dict:
    """A point on the word field as CSS: columns span the middle 80 % (as in the template)."""
    return {"x": f"{10 + at.x * 80:.2f}%", "y": f"{at.y * 100:.2f}%"}


def keyboard(ctx: Context) -> dict:
    """The touch keyboard's three rows: each key lit when it is the target's next letter,
    ringed when an untouched word starts with it."""
    run = ctx.get(Run)
    next_key = ""
    starts = set()
    for entity, word in ctx.world.query(Word).to_list():
        if entity == run.target:
            next_key = word.text[word.typed:word.typed + 1]
        elif word.typed == 0:
            starts.add(word.text[0])
    return {f"keys_{i + 1}": [{"key": k, "next": k == next_key, "start": k != next_key and k in starts}
                              for k in row] for i, row in enumerate(KEYBOARD_ROWS)}
