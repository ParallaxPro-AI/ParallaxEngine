from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("drawer_unit: the prefab spawns and its model's controls work")
async def test_drawer_unit(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.drawer_unit, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_0", 0.17)
    assert abs(model.joint("drawer_0") - 0.17) < 1e-3
    model.set_option("drawer_count", "3")
    assert model.option("drawer_count") == "3"
    assert model.socket_position("socket_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
