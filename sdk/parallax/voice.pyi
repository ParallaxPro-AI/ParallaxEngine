"""Proximity voice chat (plugins.voice()), for net games: every player hears the others
from where their avatars stand — full within `near` meters, fading to silence at `far`,
panned to the side they're on — over WebRTC audio (Opus, echo cancellation and noise
suppression by the browser). Single-player games can still read the microphone.

    plugins.voice(mode="push_to_talk", talk=Controls.talk)

Modes: "push_to_talk" (hold `talk`), "voice_activity" (send while louder than
`threshold`, plus `hangover` seconds), "open". The browser asks for the microphone the
first time `ctx.voice.start()` runs — call it from a button or key press.

    @system()
    class TalkIcons(System):
        def update(self, ctx, dt):
            for p in ctx.players:
                ctx.get(Hud).talking[p.id] = ctx.voice.talking(p)

Mutes, self-mute and volume are this player's own choices (saved in snapshots, never sent).
"""

from typing import Literal
from parallax import Player

class VoiceApi:
    @property
    def mic(self) -> Literal["off", "requesting", "live", "denied", "unavailable"]: ...
    def start(self) -> None:
        """Ask for the microphone."""
    def stop(self) -> None: ...
    @property
    def transmitting(self) -> bool:
        """This player's voice is being sent now."""
    def talking(self, player: Player) -> bool: ...
    def mute(self, player: Player, muted: bool = True) -> None:
        """Stop hearing a player, on this machine."""
    def muted(self, player: Player) -> bool: ...
    self_muted: bool
    """Send nothing, whatever the key or the microphone level."""
    volume: float
    """0..1: how loud other players are (times the master volume)."""
