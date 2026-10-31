from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("skee_ball_lane: the prefab spawns and its model's controls work")
async def test_skee_ball_lane(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.skee_ball_lane, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("ball_gate", 0.025)
    assert abs(model.joint("ball_gate") - 0.025) < 1e-3
    model.set_option("trim", "blue")
    assert model.option("trim") == "blue"
    assert model.socket_position("player").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
