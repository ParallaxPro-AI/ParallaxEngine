from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("guitar_amp: the prefab spawns and its model's controls work")
async def test_guitar_amp(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.guitar_amp, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("knob_0", 150.0)
    assert abs(model.joint("knob_0") - 150.0) < 1e-3
    model.set_option("tolex", "cream")
    assert model.option("tolex") == "cream"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
