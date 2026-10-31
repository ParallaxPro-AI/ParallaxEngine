from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("playground_swing: the prefab spawns and its model's controls work")
async def test_playground_swing(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.playground_swing, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("seat", 0.0)
    assert abs(model.joint("seat") - 0.0) < 1e-3
    model.set_option("kind", "double")
    assert model.option("kind") == "double"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
