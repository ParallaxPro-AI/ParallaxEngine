from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("piano: the prefab spawns and its model's controls work")
async def test_piano(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.piano, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("keys", 2.5)
    assert abs(model.joint("keys") - 2.5) < 1e-3
    model.set_option("style", "upright")
    assert model.option("style") == "upright"
    assert model.socket_position("socket_bench").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
