from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("floor_lamp: the prefab spawns and its model's controls work")
async def test_floor_lamp(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.floor_lamp, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arm", 19.0)
    assert abs(model.joint("arm") - 19.0) < 1e-3
    model.set_option("style", "arc")
    assert model.option("style") == "arc"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
