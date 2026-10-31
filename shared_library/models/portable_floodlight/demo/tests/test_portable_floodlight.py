from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("portable_floodlight: the prefab spawns and its model's controls work")
async def test_portable_floodlight(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.portable_floodlight, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("service_door", 52.5)
    assert abs(model.joint("service_door") - 52.5) < 1e-3
    model.set_option("paint", "orange")
    assert model.option("paint") == "orange"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
