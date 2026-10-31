from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("flip_chart_easel: the prefab spawns and its model's controls work")
async def test_flip_chart_easel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.flip_chart_easel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("page", 75.0)
    assert abs(model.joint("page") - 75.0) < 1e-3
    model.set_option("writing", "blank")
    assert model.option("writing") == "blank"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
