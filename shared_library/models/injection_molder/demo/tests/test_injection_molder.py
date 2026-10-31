from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("injection_molder: the prefab spawns and its model's controls work")
async def test_injection_molder(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.injection_molder, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("clamp", 0.225)
    assert abs(model.joint("clamp") - 0.225) < 1e-3
    model.set_option("paint", "blue")
    assert model.option("paint") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
