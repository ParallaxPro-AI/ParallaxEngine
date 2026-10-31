from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("towel_rail: the prefab spawns and its model's controls work")
async def test_towel_rail(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.towel_rail, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("valve", 150.0)
    assert abs(model.joint("valve") - 150.0) < 1e-3
    model.set_option("finish", "white")
    assert model.option("finish") == "white"
    assert model.socket_position("socket_towel").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
