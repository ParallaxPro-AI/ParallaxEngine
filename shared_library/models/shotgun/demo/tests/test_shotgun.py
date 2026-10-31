from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("shotgun: the prefab spawns and its model's controls work")
async def test_shotgun(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.shotgun, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pump", 0.03)
    assert abs(model.joint("pump") - 0.03) < 1e-3
    model.set_option("type", "double")
    assert model.option("type") == "double"
    assert model.socket_position("grip_r").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
