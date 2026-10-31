from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ping_pong_table: the prefab spawns and its model's controls work")
async def test_ping_pong_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ping_pong_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("half_a", 45.0)
    assert abs(model.joint("half_a") - 45.0) < 1e-3
    model.set_option("surface", "green")
    assert model.option("surface") == "green"
    assert model.socket_position("socket_net_centre").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
