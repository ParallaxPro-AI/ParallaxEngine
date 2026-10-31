from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("space_heater: the prefab spawns and its model's controls work")
async def test_space_heater(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.space_heater, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("thermostat", 135.0)
    assert abs(model.joint("thermostat") - 135.0) < 1e-3
    model.set_option("power", "off")
    assert model.option("power") == "off"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
