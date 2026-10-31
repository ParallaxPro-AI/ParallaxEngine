from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("locker: the prefab spawns and its model's controls work")
async def test_locker(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.locker, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_0", 60.0)
    assert abs(model.joint("door_0") - 60.0) < 1e-3
    model.set_option("config", "single")
    assert model.option("config") == "single"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
