"""Panels. The title and HUD are listed by their scenes; pause exists only in the arena;
the draft and game-over modals follow state."""

from parallax import Panel, SettingsPanel, close_panel, load_scene, open_panel, reload_scene, ui
from project import Scenes, Text

from game.actions import Controls
from game.components import Smash
from game.config import Rules
from game.content import RivalDef
from game.events import PerkPicked
from game.progress import current_rival, run_over, shields_left
from game.resources import Best, Draft, Duel, Run


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"start": load_scene(Scenes.arena, new_run=True)}


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.arena],
    toggle_with=Controls.pause)
class PauseMenu(Panel):
    """The template's shared pause card: Resume, Main Menu and Settings (its inline
    graphics / volume / language page is the built-in SettingsPanel here)."""
    actions = {"resume": close_panel(), "quit": load_scene(Scenes.title), "settings": open_panel(SettingsPanel)}


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        run = ctx.get(Run)
        duel = ctx.get(Duel)
        _, smash = ctx.world.query(Smash).single()
        owned = ctx.get(Draft).owned
        return {
            "duel": ctx.text(Text.duel_progress, number=run.rival_index + 1, total=len(ctx.content(RivalDef))),
            "rival": ctx.text(current_rival(ctx).name),
            "first_to": ctx.text(Text.first_to, points=ctx.config(Rules).win_score),
            "player_points": duel.player_points,
            "rival_points": duel.rival_points,
            "score": run.score,
            "best": max(ctx.get(Best).score, run.score),
            "rally": run.rally,
            "charge_pct": f"{round(smash.charge * 100)}%",
            "shield_ready": shields_left(ctx) > 0,
            "perks": " · ".join(ctx.text(p.data.name) for p in owned) or ctx.text(Text.none),
        }


@ui("draft", html="ui/draft.html", modal=True, layer="menu",
    when=lambda ctx: bool(ctx.get(Draft).offer))
class DraftPanel(Panel):
    actions = {"pick": PerkPicked}

    def state(self, ctx):
        run = ctx.get(Run)
        upcoming = ctx.content(RivalDef)[run.rival_index + 1].data
        return {
            "duel_won": ctx.text(Text.duel_won, number=run.rival_index + 1),
            "score": run.score,
            "next_rival": ctx.text(upcoming.name),
            "next_tagline": ctx.text(upcoming.tagline),
            "cards": [
                {"perk": p.id, "name": ctx.text(p.data.name), "description": ctx.text(p.data.description)}
                for p in ctx.get(Draft).offer
            ],
        }


@ui("game_over", html="ui/game_over.html", modal=True, layer="menu", when=run_over)
class GameOverPanel(Panel):
    actions = {"retry": reload_scene(new_run=True), "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        run = ctx.get(Run)
        beaten = run.rival_index + 1 if run.won else run.rival_index
        title = (ctx.text(Text.gauntlet_cleared) if run.won
                 else ctx.text(Text.defeated_by, rival=ctx.text(current_rival(ctx).name)))
        return {
            "won": run.won,
            "lost": not run.won,
            "title": title,
            "score": run.score,
            "best": ctx.get(Best).score,
            "rivals_beaten": f"{beaten}/{len(ctx.content(RivalDef))}",
            "best_rally": run.best_rally,
            "perks": len(ctx.get(Draft).owned),
        }
