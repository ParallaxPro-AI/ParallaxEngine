from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("padlock: the prefab spawns and its model's controls work")
async def test_padlock(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.padlock, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("shackle", 0.006)
    assert abs(model.joint("shackle") - 0.006) < 1e-3
    model.set_option("finish", "brass")
    assert model.option("finish") == "brass"
    assert model.socket_position("socket_hasp").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
