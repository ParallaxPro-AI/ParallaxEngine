from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("executive_desk: the prefab spawns and its model's controls work")
async def test_executive_desk(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.executive_desk, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_l1", 0.19)
    assert abs(model.joint("drawer_l1") - 0.19) < 1e-3
    model.set_option("wood", "walnut")
    assert model.option("wood") == "walnut"
    assert model.socket_position("socket_desktop").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
