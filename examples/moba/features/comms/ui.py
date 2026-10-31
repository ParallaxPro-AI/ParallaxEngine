from parallax import Context, Panel, ui
from project import Scenes, Text

from game.viewer import my_hero

CHAT_LINES = 8
"""Lines the chat box shows; the plugin keeps the history."""


def say(ctx: Context, text: str) -> None:
    ctx.chat.send(text)


@ui("chat", html="ui/chat.html", scenes=[Scenes.arena], when=lambda ctx: my_hero(ctx) is not None)
class ChatBox(Panel):
    """The last few chat lines, the input (Enter opens it), and who is talking."""

    actions = {"send": say}

    def state(self, ctx):
        talking = [p.name for p in ctx.players if ctx.voice.talking(p)]
        me = ctx.net.local_player
        return {
            "lines": [{"name": line.name, "text": line.text, "me": me is not None and line.player == me}
                      for line in ctx.chat.lines[-CHAT_LINES:]],
            "talking": ", ".join(talking),
            "transmitting": ctx.voice.transmitting,
            "mic_denied": ctx.voice.mic == "denied",
            "hint": ctx.text(Text.chat_hint),
        }
