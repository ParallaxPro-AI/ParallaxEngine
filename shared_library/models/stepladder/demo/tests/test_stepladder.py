from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("stepladder: the prefab spawns and its model's controls work")
async def test_stepladder(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.stepladder, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fold", 9.0)
    assert abs(model.joint("fold") - 9.0) < 1e-3
    model.set_option("finish", "aluminium")
    assert model.option("finish") == "aluminium"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
