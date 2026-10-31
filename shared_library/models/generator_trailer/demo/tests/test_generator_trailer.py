from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("generator_trailer: the prefab spawns and its model's controls work")
async def test_generator_trailer(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.generator_trailer, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("jockey", 0.11)
    assert abs(model.joint("jockey") - 0.11) < 1e-3
    model.set_option("colour", "white")
    assert model.option("colour") == "white"
    assert model.socket_position("socket_hitch").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
