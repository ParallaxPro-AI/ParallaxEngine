from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bear_trap: the prefab spawns and its model's controls work")
async def test_bear_trap(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bear_trap, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pan", 0.003)
    assert abs(model.joint("pan") - 0.003) < 1e-3
    model.set_option("finish", "rusted")
    assert model.option("finish") == "rusted"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
