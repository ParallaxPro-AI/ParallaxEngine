from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("train_station: the prefab spawns and its model's controls work")
async def test_train_station(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.train_station, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("waiting_vending_glass_door", 60.0)
    assert abs(model.joint("waiting_vending_glass_door") - 60.0) < 1e-3
    model.set_option("paintwork", "maroon")
    assert model.option("paintwork") == "maroon"
    assert model.socket_position("socket_street").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
