from parallax import System, system

from game.actions import Controls


@system("microphone", runs_on="client")
class Microphone(System):
    """The browser asks for the microphone only from a key press: the first V does it.
    Holding V afterwards is the voice plugin's push-to-talk."""

    def update(self, ctx, dt):
        if ctx.input.pressed(Controls.talk) and ctx.voice.mic == "off":
            ctx.voice.start()
