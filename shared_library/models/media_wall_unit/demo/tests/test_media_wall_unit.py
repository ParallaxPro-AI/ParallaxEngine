from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("media_wall_unit: the prefab spawns and its model's controls work")
async def test_media_wall_unit(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.media_wall_unit, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 50.0)
    assert abs(model.joint("door_l") - 50.0) < 1e-3
    model.set_option("finish", "graphite")
    assert model.option("finish") == "graphite"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
