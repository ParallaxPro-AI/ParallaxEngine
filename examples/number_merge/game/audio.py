"""The template's cue sheet: each sound is a catalog asset with the volume the template
plays it at (config/audio.json). The music's volume (0.28) is its assets/audio.json entry."""

from parallax import MusicRef, SoundRef, config, field, record


@record
class Cue:
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@config("audio")
class Sounds:
    music: MusicRef = field(doc="The board's loop; it plays only while a game is being played.")
    move: Cue = field(doc="A slide that changed the board.")
    merge: Cue = field(doc="At least one pair fused in a slide.")
    spawn: Cue = field(doc="A new tile (and the dealt starting board).")
    milestone: Cue = field()
    win: Cue = field()
    lose: Cue = field()


def play(ctx, cue: Cue):
    ctx.audio.play(cue.sound, volume=cue.volume)
