from parallax import System, on, system

from game.config import Cue, Cues

from game.events import Bumped, LevelReset, LevelSolved, MoveUndone, ShiftCompleted, Stepped


def play(ctx, cue: Cue) -> None:
    ctx.audio.play(cue.sound, volume=cue.volume)


@system("feedback")
class Feedback(System):
    """Sound. Reacts to what the yard rules report and changes no game
    state. Sounds and volumes live in config/cues.json and the yard's music is the scene's.
    (The dock burst lives with the crate, in `dock_light`.)"""

    @on(Stepped)
    def stepped(self, ctx, event):
        if event.docked:
            play(ctx, ctx.config(Cues).place)
        elif event.undocked:
            play(ctx, ctx.config(Cues).lift)
        elif event.pushed:
            play(ctx, ctx.config(Cues).push)
        else:
            play(ctx, ctx.config(Cues).step)

    @on(Bumped)
    def bumped(self, ctx, event):
        play(ctx, ctx.config(Cues).blocked)

    @on(MoveUndone)
    def undone(self, ctx, event):
        play(ctx, ctx.config(Cues).undo)

    @on(LevelReset)
    def reset(self, ctx, event):
        play(ctx, ctx.config(Cues).reset)

    @on(LevelSolved)
    def solved(self, ctx, event):
        play(ctx, ctx.config(Cues).level_clear)

    @on(ShiftCompleted)
    def completed(self, ctx, event):
        play(ctx, ctx.config(Cues).win)
