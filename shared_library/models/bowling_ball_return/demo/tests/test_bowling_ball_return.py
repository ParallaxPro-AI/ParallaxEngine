from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bowling_ball_return: the prefab spawns and its model's controls work")
async def test_bowling_ball_return(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bowling_ball_return, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flap", 30.0)
    assert abs(model.joint("flap") - 30.0) < 1e-3
    model.set_option("hood", "red")
    assert model.option("hood") == "red"
    assert model.socket_position("ball_slot_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
