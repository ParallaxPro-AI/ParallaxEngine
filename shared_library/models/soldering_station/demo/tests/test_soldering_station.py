from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("soldering_station: the prefab spawns and its model's controls work")
async def test_soldering_station(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.soldering_station, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("temp_knob", 135.0)
    assert abs(model.joint("temp_knob") - 135.0) < 1e-3
    model.set_option("unit", "blue")
    assert model.option("unit") == "blue"
    assert model.socket_position("socket_iron_tip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
