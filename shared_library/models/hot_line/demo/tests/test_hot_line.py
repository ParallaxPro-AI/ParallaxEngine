from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hot_line: the prefab spawns and its model's controls work")
async def test_hot_line(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hot_line, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("oven_door_0", 44.0)
    assert abs(model.joint("oven_door_0") - 44.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
