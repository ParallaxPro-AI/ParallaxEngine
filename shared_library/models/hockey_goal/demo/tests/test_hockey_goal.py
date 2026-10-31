from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hockey_goal: the prefab spawns and its model's controls work")
async def test_hockey_goal(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hockey_goal, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("frame", "blue")
    assert model.option("frame") == "blue"
    assert model.socket_position("socket_goal_centre").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
