"""Demo host for scene_tags: a system scoped to playable scenes."""

from parallax import Game, System, resource, system
from project import Scenes

from game.lib.scene_tags import Playable


@resource("ticks")
class Ticks:
    frames: int = 0


@system("count_playable_frames", scenes=[Playable])
class CountPlayableFrames(System):
    def update(self, ctx, dt):
        ctx.get(Ticks).frames += 1


game = Game(id="scene_tags_demo", title="Scene tags demo", sdk="1.0", mode="2d",
            systems=[CountPlayableFrames], start_scene=Scenes.title)
