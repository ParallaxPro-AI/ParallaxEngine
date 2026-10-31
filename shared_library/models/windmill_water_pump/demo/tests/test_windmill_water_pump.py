from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("windmill_water_pump: the prefab spawns and its model's controls work")
async def test_windmill_water_pump(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.windmill_water_pump, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pump_rod", 0.075)
    assert abs(model.joint("pump_rod") - 0.075) < 1e-3
    model.set_option("vane_colour", "grey")
    assert model.option("vane_colour") == "grey"
    assert model.socket_position("socket_spout").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
