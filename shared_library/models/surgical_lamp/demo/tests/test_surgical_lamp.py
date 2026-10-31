from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("surgical_lamp: the prefab spawns and its model's controls work")
async def test_surgical_lamp(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.surgical_lamp, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("sat_head_tilt", 0.0)
    assert abs(model.joint("sat_head_tilt") - 0.0) < 1e-3
    model.set_option("power", "off")
    assert model.option("power") == "off"
    assert model.socket_position("socket_ceiling").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
