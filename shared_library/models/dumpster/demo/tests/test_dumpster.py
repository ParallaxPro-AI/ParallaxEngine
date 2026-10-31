from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dumpster: the prefab spawns and its model's controls work")
async def test_dumpster(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dumpster, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid_l", 55.0)
    assert abs(model.joint("lid_l") - 55.0) < 1e-3
    model.set_option("paint", "blue")
    assert model.option("paint") == "blue"
    assert model.socket_position("socket_contents").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
