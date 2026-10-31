from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("suitcase: the prefab spawns and its model's controls work")
async def test_suitcase(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.suitcase, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 55.0)
    assert abs(model.joint("lid") - 55.0) < 1e-3
    model.set_option("shell_type", "soft")
    assert model.option("shell_type") == "soft"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
