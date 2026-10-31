from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("spotlight: the prefab spawns and its model's controls work")
async def test_spotlight(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.spotlight, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pan", 0.0)
    assert abs(model.joint("pan") - 0.0) < 1e-3
    model.set_option("variant", "studio")
    assert model.option("variant") == "studio"
    assert model.socket_position("socket_gel").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
