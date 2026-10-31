from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("spinning_top: the prefab spawns and its model's controls work")
async def test_spinning_top(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.spinning_top, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tilt", 7.0)
    assert abs(model.joint("tilt") - 7.0) < 1e-3
    model.set_option("main_paint", "green")
    assert model.option("main_paint") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
