from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("chicken: the prefab spawns and its model's controls work")
async def test_chicken(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.chicken, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("neck", 6.0)
    assert abs(model.joint("neck") - 6.0) < 1e-3
    model.set_option("plumage", "white")
    assert model.option("plumage") == "white"
    assert model.socket_position("socket_back").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
