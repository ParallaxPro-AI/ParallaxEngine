from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sump_pump: the prefab spawns and its model's controls work")
async def test_sump_pump(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sump_pump, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("float_assembly", 0.05)
    assert abs(model.joint("float_assembly") - 0.05) < 1e-3
    model.set_option("motor", "green")
    assert model.option("motor") == "green"
    assert model.socket_position("socket_discharge_end").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
