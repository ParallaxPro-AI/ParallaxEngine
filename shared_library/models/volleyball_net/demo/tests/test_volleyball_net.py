from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("volleyball_net: the prefab spawns and its model's controls work")
async def test_volleyball_net(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.volleyball_net, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("net", 0.215)
    assert abs(model.joint("net") - 0.215) < 1e-3
    model.set_option("pads", "red")
    assert model.option("pads") == "red"
    assert model.socket_position("socket_net_top_centre").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
