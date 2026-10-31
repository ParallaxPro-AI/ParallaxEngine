from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("water_heater_tank: the prefab spawns and its model's controls work")
async def test_water_heater_tank(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.water_heater_tank, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cold_valve_lever", 45.0)
    assert abs(model.joint("cold_valve_lever") - 45.0) < 1e-3
    model.set_option("fuel", "electric")
    assert model.option("fuel") == "electric"
    assert model.socket_position("socket_vent_outlet").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
