from parallax import Panel, close_panel, load_scene, ui
from project import Scenes

from game.actions import Controls
from game.resources import Tally


def add(ctx, amount: int):
    ctx.get(Tally).value += amount


@ui("board", html="ui/board.html")
class Board(Panel):
    actions = {"add": add}

    def state(self, ctx):
        return {"value": ctx.get(Tally).value}


@ui("start_menu", html="ui/start.html", layer="menu")
class StartMenu(Panel):
    actions = {"play": load_scene(Scenes.arena)}


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.arena],
    toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel()}
