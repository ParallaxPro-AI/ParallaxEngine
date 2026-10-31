from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("grandfather_clock: the prefab spawns and its model's controls work")
async def test_grandfather_clock(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.grandfather_clock, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pendulum", 0.0)
    assert abs(model.joint("pendulum") - 0.0) < 1e-3
    model.set_option("finish", "oak")
    assert model.option("finish") == "oak"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
