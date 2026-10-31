from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("stage_curtain: the prefab spawns and its model's controls work")
async def test_stage_curtain(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.stage_curtain, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("panel_l", 0.6)
    assert abs(model.joint("panel_l") - 0.6) < 1e-3
    model.set_option("frame", "none")
    assert model.option("frame") == "none"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
