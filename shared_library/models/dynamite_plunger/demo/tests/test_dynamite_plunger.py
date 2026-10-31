from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dynamite_plunger: the prefab spawns and its model's controls work")
async def test_dynamite_plunger(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dynamite_plunger, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("plunger", 0.075)
    assert abs(model.joint("plunger") - 0.075) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
