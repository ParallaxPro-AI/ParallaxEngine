from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("forklift_charging_station: the prefab spawns and its model's controls work")
async def test_forklift_charging_station(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.forklift_charging_station, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cab_door", 52.5)
    assert abs(model.joint("cab_door") - 52.5) < 1e-3
    model.set_option("status", "charged")
    assert model.option("status") == "charged"
    assert model.socket_position("park").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
