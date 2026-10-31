from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ski_lift_chair: the prefab spawns and its model's controls work")
async def test_ski_lift_chair(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ski_lift_chair, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("safety_bar", 40.0)
    assert abs(model.joint("safety_bar") - 40.0) < 1e-3
    model.set_option("cushion", "red")
    assert model.option("cushion") == "red"
    assert model.socket_position("seat_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
