from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dunk_tank: the prefab spawns and its model's controls work")
async def test_dunk_tank(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dunk_tank, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("seat", 41.0)
    assert abs(model.joint("seat") - 41.0) < 1e-3
    model.set_option("frame", "blue")
    assert model.option("frame") == "blue"
    assert model.socket_position("socket_seat").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
