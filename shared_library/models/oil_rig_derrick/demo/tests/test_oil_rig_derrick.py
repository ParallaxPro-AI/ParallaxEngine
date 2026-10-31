from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("oil_rig_derrick: the prefab spawns and its model's controls work")
async def test_oil_rig_derrick(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.oil_rig_derrick, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("traveling_block", 12.0)
    assert abs(model.joint("traveling_block") - 12.0) < 1e-3
    model.set_option("paint", "white")
    assert model.option("paint") == "white"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
