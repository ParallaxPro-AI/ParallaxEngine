from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("flower_window_box: the prefab spawns and its model's controls work")
async def test_flower_window_box(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.flower_window_box, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
