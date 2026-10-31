from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("spinning_wheel: the prefab spawns and its model's controls work")
async def test_spinning_wheel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.spinning_wheel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("treadle", 4.8)
    assert abs(model.joint("treadle") - 4.8) < 1e-3
    model.set_option("yarn", "red")
    assert model.option("yarn") == "red"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
