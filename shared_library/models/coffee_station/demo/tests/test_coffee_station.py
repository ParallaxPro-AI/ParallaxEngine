from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("coffee_station: the prefab spawns and its model's controls work")
async def test_coffee_station(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.coffee_station, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer", 0.2)
    assert abs(model.joint("drawer") - 0.2) < 1e-3
    model.set_option("units", "grey")
    assert model.option("units") == "grey"
    assert model.socket_position("socket_counter").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
