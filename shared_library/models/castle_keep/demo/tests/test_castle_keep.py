from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("castle_keep: the prefab spawns and its model's controls work")
async def test_castle_keep(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.castle_keep, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 52.5)
    assert abs(model.joint("door_l") - 52.5) < 1e-3
    model.set_option("banner", "blue")
    assert model.option("banner") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
