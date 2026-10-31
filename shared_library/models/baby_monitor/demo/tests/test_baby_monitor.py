from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("baby_monitor: the prefab spawns and its model's controls work")
async def test_baby_monitor(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.baby_monitor, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cam_pan", 0.0)
    assert abs(model.joint("cam_pan") - 0.0) < 1e-3
    model.set_option("accent", "pink")
    assert model.option("accent") == "pink"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
