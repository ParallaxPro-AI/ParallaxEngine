from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("canopic_jar_set: the prefab spawns and its model's controls work")
async def test_canopic_jar_set(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.canopic_jar_set, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("imsety_lid", 0.06)
    assert abs(model.joint("imsety_lid") - 0.06) < 1e-3
    model.set_option("stone", "limestone")
    assert model.option("stone") == "limestone"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
