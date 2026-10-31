from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crt_monitor: the prefab spawns and its model's controls work")
async def test_crt_monitor(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crt_monitor, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("swivel", 0.0)
    assert abs(model.joint("swivel") - 0.0) < 1e-3
    model.set_option("screen_state", "amber")
    assert model.option("screen_state") == "amber"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
