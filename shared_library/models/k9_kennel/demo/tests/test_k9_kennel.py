from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("k9_kennel: the prefab spawns and its model's controls work")
async def test_k9_kennel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.k9_kennel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("gate", 50.0)
    assert abs(model.joint("gate") - 50.0) < 1e-3
    model.set_option("roof", "open")
    assert model.option("roof") == "open"
    assert model.socket_position("socket_dog").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
