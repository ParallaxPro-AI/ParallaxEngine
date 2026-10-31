from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hurdle: the prefab spawns and its model's controls work")
async def test_hurdle(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hurdle, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tip_over", 41.0)
    assert abs(model.joint("tip_over") - 41.0) < 1e-3
    model.set_option("stripes", "red")
    assert model.option("stripes") == "red"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
