from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fishing_rod: the prefab spawns and its model's controls work")
async def test_fishing_rod(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fishing_rod, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bail", 75.0)
    assert abs(model.joint("bail") - 75.0) < 1e-3
    model.set_option("reel", "none")
    assert model.option("reel") == "none"
    assert model.socket_position("line_tip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
