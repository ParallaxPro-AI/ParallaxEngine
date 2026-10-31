"""The title screen, the pause card, the fallen overlay and the end-of-run card. The HUD is in game/hud.py."""

import math

from parallax import Panel, close_panel, open_panel, reload_scene, ui
from parallax.story import DialoguePanel
from project import Text

from features.combat.feature import RunStats
from features.hero.feature import Respawn
from features.inventory.feature import Economy
from features.quests.feature import Chapter, Doom, Ending, JournalPanel, Outcome, ShadowRift, rift_running
from game.actions import MenuControls
from game.session import save_and_quit, walk_the_road


@ui("title", html="ui/title.html", modal=True, layer="menu")
class TitleScreen(Panel):
    """The lantern-glass card over the village: one button onto the lantern road."""

    actions = {"start_game": walk_the_road}


@ui("bark_card", html="ui/dialogue.html", modal=True, layer="overlay")
class BarkCard(DialoguePanel):
    """NPC conversations in the template's bark card instead of the engine's dialogue box."""

    actions = DialoguePanel.actions

    def state(self, ctx):
        return super().state(ctx)


@ui("pause", html="ui/pause.html", modal=True, layer="menu", toggle_with=MenuControls.pause)
class PauseMenu(Panel):
    """P opens and closes it."""

    actions = {"resume": close_panel(), "journal": open_panel(JournalPanel), "main_menu": save_and_quit}


@ui("fallen", html="ui/fallen.html", layer="overlay", when=lambda ctx: not ctx.get(Respawn).countdown.done)
class FallenScreen(Panel):
    """While the hero is down: the lantern ring fills, the tithe is named, and what the fall cost the rift."""

    def state(self, ctx):
        return {
            "line": ctx.text(Text.fallen_line, percent=round(ctx.config(Economy).death_toll * 100)),
            "rift_open": rift_running(ctx),
            "rift_cost": ctx.text(Text.rift_cost, seconds=round(ctx.config(ShadowRift).death_penalty)),
        }


@ui("game_over", html="ui/game_over.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Outcome).ending is not Ending.NONE)
class GameOverScreen(Panel):
    """Victory or the fall of Sundermere, with the run's stats. Open exactly while the run has an ending."""

    actions = {"play_again": reload_scene(new_run=True), "main_menu": save_and_quit}

    def state(self, ctx):
        won = ctx.get(Outcome).ending is Ending.VICTORY
        stats = ctx.get(RunStats)
        kills = {"label": ctx.text(Text.stat_kills), "value": stats.kills}
        if won:
            left = math.floor(ctx.get(Doom).clock.remaining)
            rows = [
                kills,
                {"label": ctx.text(Text.stat_story_beats),
                 "value": f"{len(ctx.story.quests('completed'))} / {len(ctx.content(Chapter))}"},
                {"label": ctx.text(Text.stat_rift_left), "value": f"{left // 60}:{left % 60:02d}"},
            ]
        else:
            rows = [kills, {"label": ctx.text(Text.stat_best_streak), "value": stats.best_streak}]
        return {
            "lost": not won,
            "eyebrow": ctx.text(Text.victory_eyebrow if won else Text.defeat_eyebrow),
            "title": ctx.text(Text.victory_title if won else Text.defeat_title),
            "story": ctx.text(Text.victory_story if won else Text.defeat_story),
            "stats": rows,
        }
