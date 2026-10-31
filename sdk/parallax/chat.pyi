"""Text chat (plugins.chat()). In a net game the authority (host or server) accepts each
line and every client shows the same lines in the same order. Lines are refused (to the
sender only, `ChatRejected`) when empty, longer than `max_length`, faster than the rate
limit (`burst` at once, `per_second` sustained, per player), or when the game's `filter`
returns None — the profanity hook, which may also return a masked text:

    BAD = {"darn", "heck"}
    def clean(ctx, player, text):
        return " ".join("****" if w.lower() in BAD else w for w in text.split())

    Game(plugins=[plugins.net(...), plugins.chat(filter=clean)])

    @ui("chat", html="ui/chat.html")
    class ChatBox(Panel):
        actions = {"send": lambda ctx, text: ctx.chat.send(text)}
        def state(self, ctx):
            return {"lines": [{"name": l.name, "text": l.text} for l in ctx.chat.lines]}
"""

from typing import Literal
from parallax import Player, event

class ChatLine:
    @property
    def player(self) -> Player | None:
        """Who said it (None once they left)."""
    @property
    def name(self) -> str: ...
    @property
    def text(self) -> str: ...
    @property
    def time(self) -> float: ...

@event("chat_message")
class ChatMessage:
    player: Player | None
    name: str
    text: str
    time: float

@event("chat_rejected")
class ChatRejected:
    player: Player | None
    reason: Literal["empty", "too_long", "rate", "filtered"]
    text: str

class ChatApi:
    def send(self, text: str, *, player: Player | None = None) -> bool:
        """Say `text` as this machine's player. False when refused at once (empty, too long);
        other refusals arrive as ChatRejected."""
    @property
    def lines(self) -> list[ChatLine]:
        """The recent lines, oldest first, without muted players'."""
    def mute(self, player: Player, muted: bool = True) -> None: ...
    def muted(self, player: Player) -> bool: ...
