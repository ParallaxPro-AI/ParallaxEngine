from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("electric_guitar: the prefab spawns and its model's controls work")
async def test_electric_guitar(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.electric_guitar, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("knob_volume", 150.0)
    assert abs(model.joint("knob_volume") - 150.0) < 1e-3
    model.set_option("finish", "blue")
    assert model.option("finish") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
