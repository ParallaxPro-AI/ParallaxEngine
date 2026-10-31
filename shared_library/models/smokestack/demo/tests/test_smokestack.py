from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("smokestack: the prefab spawns and its model's controls work")
async def test_smokestack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.smokestack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("access_door", 50.0)
    assert abs(model.joint("access_door") - 50.0) < 1e-3
    model.set_option("banding", "plain")
    assert model.option("banding") == "plain"
    assert model.socket_position("smoke").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
