from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bounce_mushroom: the prefab spawns and its model's controls work")
async def test_bounce_mushroom(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bounce_mushroom, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cap", 0.07)
    assert abs(model.joint("cap") - 0.07) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
