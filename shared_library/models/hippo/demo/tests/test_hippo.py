from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hippo: the prefab spawns and its model's controls work")
async def test_hippo(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hippo, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("jaw", 19.0)
    assert abs(model.joint("jaw") - 19.0) < 1e-3
    model.set_option("hide", "dark")
    assert model.option("hide") == "dark"
    assert model.socket_position("back").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
