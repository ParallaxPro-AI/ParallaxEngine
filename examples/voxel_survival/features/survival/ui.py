from parallax import Panel, load_scene, ui
from project import Scenes, Text

from features.survival.actions import wake_up
from features.survival.lives import player_down, run_over
from features.survival.resources import Run
from game.config import Rules
from game.world import day_number, hearts


@ui("death_screen", html="ui/death_screen.html", modal=True,
    when=lambda ctx: player_down(ctx) and not run_over(ctx))
class DeathScreen(Panel):
    actions = {"respawn": wake_up}

    def state(self, ctx):
        run = ctx.get(Run)
        total = ctx.config(Rules).lives
        left = total - run.deaths
        return {"challenge": run.challenge, "hearts": hearts(total, left),
                "lives_text": ctx.text(Text.lives_left, count=left)}


@ui("game_over", html="ui/game_over.html", modal=True, when=run_over)
class GameOverScreen(Panel):
    actions = {
        "play_again": load_scene(Scenes.greenwood, new_run=True, init=[Run(challenge=True)]),
        "title": load_scene(Scenes.title, new_run=True),
    }

    def state(self, ctx):
        total = ctx.config(Rules).lives
        return {"days": day_number(ctx), "hearts": hearts(total, 0),
                "lives_spent": ctx.text(Text.lives_spent, count=total)}
