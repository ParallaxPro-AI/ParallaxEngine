from parallax import Color, PanelClosed, PanelOpened, System, on, system
from project import Assets, Scenes

from game.board import tile_def
from game.audio import Sounds, play
from game.config import Rules
from game.events import BoardDealt, GameEnded, MilestoneReached, Slid, TileSpawned, TilesFused
from game.ui import PauseMenu, ResultPanel


@system("feedback", scenes=[Scenes.board])
class Feedback(System):
    """Sound, music, particles and shake. Reacts to what the slider reports and changes
    no game state. The cues and their volumes are config/audio.json.

    The music plays only while a game is being played: pausing or ending the game stops
    it, and resuming starts it again."""

    def start(self, ctx):
        ctx.audio.music(ctx.config(Sounds).music)

    @on(PanelOpened, where=lambda e: e.panel in (PauseMenu, ResultPanel))
    def menu_opened(self, ctx, event):
        ctx.audio.music(None, fade=0)

    @on(PanelClosed, where=lambda e: e.panel is PauseMenu)
    def resumed(self, ctx, event):
        ctx.audio.music(ctx.config(Sounds).music)

    @on(BoardDealt)
    def dealt(self, ctx, event):
        play(ctx, ctx.config(Sounds).spawn)

    @on(Slid)
    def slid(self, ctx, event):
        cues = ctx.config(Sounds)
        play(ctx, cues.move)
        if event.fused:
            play(ctx, cues.merge)

    @on(TilesFused)
    def fused(self, ctx, event):
        # The burst starts at the new tile's colour + 0.3 and fades out to the tile's colour.
        tile = tile_def(ctx, event.value).color
        light = Color(min(1, tile.r + 0.3), min(1, tile.g + 0.3), min(1, tile.b + 0.3))
        ctx.vfx.play(Assets.vfx.fuse_burst, at=event.at, color=light, color_end=tile)

    @on(TileSpawned)
    def spawned(self, ctx, event):
        play(ctx, ctx.config(Sounds).spawn)

    @on(MilestoneReached)
    def milestone(self, ctx, event):
        rules = ctx.config(Rules)
        play(ctx, ctx.config(Sounds).milestone)
        ctx.camera.main.shake(min(rules.shake_max, rules.shake + rules.shake_per_value * event.value),
                              rules.shake_seconds)

    @on(GameEnded)
    def ended(self, ctx, event):
        cues = ctx.config(Sounds)
        play(ctx, cues.win if event.won else cues.lose)
