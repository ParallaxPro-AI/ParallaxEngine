from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("control_panel: the prefab spawns and its model's controls work")
async def test_control_panel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.control_panel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("gauge_needle_0", 0.0)
    assert abs(model.joint("gauge_needle_0") - 0.0) < 1e-3
    model.set_option("style", "retro")
    assert model.option("style") == "retro"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
