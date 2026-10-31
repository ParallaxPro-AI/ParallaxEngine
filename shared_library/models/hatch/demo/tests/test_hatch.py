from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hatch: the prefab spawns and its model's controls work")
async def test_hatch(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hatch, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 44.0)
    assert abs(model.joint("lid") - 44.0) < 1e-3
    model.set_option("mounting", "ceiling")
    assert model.option("mounting") == "ceiling"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
