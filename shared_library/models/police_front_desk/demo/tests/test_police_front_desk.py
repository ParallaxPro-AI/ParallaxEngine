from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("police_front_desk: the prefab spawns and its model's controls work")
async def test_police_front_desk(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.police_front_desk, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_1", 0.2)
    assert abs(model.joint("drawer_1") - 0.2) < 1e-3
    model.set_option("finish", "wood")
    assert model.option("finish") == "wood"
    assert model.socket_position("socket_officer").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
