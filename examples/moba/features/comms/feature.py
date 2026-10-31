"""Comms: in-match text chat (Enter) and push-to-talk voice (hold V), both the
engine's plugins (`chat()`, `voice()`); this feature only draws them and asks for
the microphone the first time V is pressed."""

from parallax import Feature
from project import Scenes

from features.comms.systems import Microphone
from features.comms.ui import ChatBox

comms = Feature(
    "comms",
    systems=[Microphone],
    scenes=[Scenes.arena],
    doc="Text chat and push-to-talk voice.",
)

__all__ = ["comms", "ChatBox"]
