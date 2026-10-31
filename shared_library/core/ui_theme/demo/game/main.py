"""Demo host for ui_theme: one panel styled with the library theme."""

from parallax import Game, Panel, ui
from project import Scenes


@ui("themed_card", html="ui/themed_card.html")
class ThemedCard(Panel):
    def state(self, ctx):
        return {"label": "Score", "value": 1250}


game = Game(id="ui_theme_demo", title="UI theme demo", sdk="1.0", mode="2d", start_scene=Scenes.main)
