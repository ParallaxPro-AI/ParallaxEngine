from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("nurse_station: the prefab spawns and its model's controls work")
async def test_nurse_station(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.nurse_station, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_0", 0.2)
    assert abs(model.joint("drawer_0") - 0.2) < 1e-3
    model.set_option("accent", "blue")
    assert model.option("accent") == "blue"
    assert model.socket_position("staff_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
