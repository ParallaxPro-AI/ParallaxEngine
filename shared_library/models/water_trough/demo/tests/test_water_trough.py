from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("water_trough: the prefab spawns and its model's controls work")
async def test_water_trough(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.water_trough, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("float_valve", 10.0)
    assert abs(model.joint("float_valve") - 10.0) < 1e-3
    assert model.socket_position("socket_supply").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
