from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("battery_storage_container: the prefab spawns and its model's controls work")
async def test_battery_storage_container(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.battery_storage_container, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_0", 52.5)
    assert abs(model.joint("door_0") - 52.5) < 1e-3
    model.set_option("shell", "grey")
    assert model.option("shell") == "grey"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
