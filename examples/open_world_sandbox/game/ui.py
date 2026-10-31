"""The title screen, the pause menu and its leave confirmation. The HUD is in game/hud.py."""

from parallax import Panel, SettingsPanel, close_panel, load_scene, open_panel, ui
from project import Scenes

from game.actions import Controls
from game.session import play


@ui("title", html="ui/title.html", modal=True, layer="menu")
class TitleScreen(Panel):
    """The SUNSET BAY wordmark, the tagline and Play (which picks up the safehouse save when there is one)."""

    actions = {"play": play}


@ui("leave", html="ui/leave.html", modal=True, layer="menu")
class LeaveConfirm(Panel):
    """"Leave the streets?" Anything since the last safehouse save is lost."""

    actions = {"stay": close_panel(), "leave": load_scene(Scenes.title)}


@ui("pause", html="ui/pause.html", modal=True, layer="menu", toggle_with=Controls.pause)
class PauseMenu(Panel):
    """P opens and closes it. Leaving doesn't save: Sunset Bay saves at the safehouse and after every
    paid job."""

    actions = {"resume": close_panel(), "settings": open_panel(SettingsPanel), "main_menu": open_panel(LeaveConfirm)}
