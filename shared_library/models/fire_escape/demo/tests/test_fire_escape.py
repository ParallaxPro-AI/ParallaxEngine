from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fire_escape: the prefab spawns and its model's controls work")
async def test_fire_escape(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fire_escape, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drop_ladder", 1.2)
    assert abs(model.joint("drop_ladder") - 1.2) < 1e-3
    model.set_option("paint", "oxide_red")
    assert model.option("paint") == "oxide_red"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
