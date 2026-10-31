from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("soda_fountain: the prefab spawns and its model's controls work")
async def test_soda_fountain(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.soda_fountain, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lever_1", 7.0)
    assert abs(model.joint("lever_1") - 7.0) < 1e-3
    model.set_option("panel", "blue")
    assert model.option("panel") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
