from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cheese_wheel: the prefab spawns and its model's controls work")
async def test_cheese_wheel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cheese_wheel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("wedge", 0.05)
    assert abs(model.joint("wedge") - 0.05) < 1e-3
    model.set_option("rind", "red_wax")
    assert model.option("rind") == "red_wax"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
