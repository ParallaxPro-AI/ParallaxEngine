from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("wok_station: the prefab spawns and its model's controls work")
async def test_wok_station(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.wok_station, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("faucet_1", 0.0)
    assert abs(model.joint("faucet_1") - 0.0) < 1e-3
    model.set_option("woks", "empty")
    assert model.option("woks") == "empty"
    assert model.socket_position("wok_seat_1").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
