from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("military_radio: the prefab spawns and its model's controls work")
async def test_military_radio(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.military_radio, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tune_mhz", 150.0)
    assert abs(model.joint("tune_mhz") - 150.0) < 1e-3
    model.set_option("housing", "tan")
    assert model.option("housing") == "tan"
    assert model.socket_position("handset").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
