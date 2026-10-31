from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fuel_pump_island: the prefab spawns and its model's controls work")
async def test_fuel_pump_island(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fuel_pump_island, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("nozzle_f_0", 35.0)
    assert abs(model.joint("nozzle_f_0") - 35.0) < 1e-3
    model.set_option("brand", "blue")
    assert model.option("brand") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
