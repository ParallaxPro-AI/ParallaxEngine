from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("roll_cage: the prefab spawns and its model's controls work")
async def test_roll_cage(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.roll_cage, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("gate", 48.0)
    assert abs(model.joint("gate") - 48.0) < 1e-3
    model.set_option("load", "picked")
    assert model.option("load") == "picked"
    assert model.socket_position("socket_handle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
