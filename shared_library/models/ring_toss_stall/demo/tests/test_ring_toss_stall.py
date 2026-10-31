from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ring_toss_stall: the prefab spawns and its model's controls work")
async def test_ring_toss_stall(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ring_toss_stall, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("counter_flap", 47.5)
    assert abs(model.joint("counter_flap") - 47.5) < 1e-3
    model.set_option("stripes", "blue")
    assert model.option("stripes") == "blue"
    assert model.socket_position("socket_player").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
