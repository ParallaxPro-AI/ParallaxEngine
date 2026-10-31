from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("eagle: the prefab spawns and its model's controls work")
async def test_eagle(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.eagle, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("head_turn", 0.0)
    assert abs(model.joint("head_turn") - 0.0) < 1e-3
    model.set_option("pose", "perched")
    assert model.option("pose") == "perched"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
