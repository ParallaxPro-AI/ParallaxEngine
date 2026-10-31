from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crate: the prefab spawns and its model's controls work")
async def test_crate(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crate, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 0.16)
    assert abs(model.joint("lid") - 0.16) < 1e-3
    model.set_option("stencil", "fragile")
    assert model.option("stencil") == "fragile"
    assert model.socket_position("socket_contents").distance_to(thing.transform.position) < 2.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
