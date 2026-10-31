from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("goal_post: the prefab spawns and its model's controls work")
async def test_goal_post(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.goal_post, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("net", 4.0)
    assert abs(model.joint("net") - 4.0) < 1e-3
    model.set_option("config", "hockey")
    assert model.option("config") == "hockey"
    assert model.socket_position("socket_goal_centre").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
