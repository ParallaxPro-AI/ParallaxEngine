from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("combination_lock_dial: the prefab spawns and its model's controls work")
async def test_combination_lock_dial(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.combination_lock_dial, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("shackle", 0.005)
    assert abs(model.joint("shackle") - 0.005) < 1e-3
    model.set_option("finish", "green")
    assert model.option("finish") == "green"
    assert model.socket_position("socket_hasp").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
