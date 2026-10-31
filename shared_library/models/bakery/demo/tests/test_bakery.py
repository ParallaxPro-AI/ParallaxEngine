from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bakery: the prefab spawns and its model's controls work")
async def test_bakery(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bakery, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("case_a_glass_left", 0.285)
    assert abs(model.joint("case_a_glass_left") - 0.285) < 1e-3
    model.set_option("shopfront_colour", "green")
    assert model.option("shopfront_colour") == "green"
    assert model.socket_position("socket_entrance").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
