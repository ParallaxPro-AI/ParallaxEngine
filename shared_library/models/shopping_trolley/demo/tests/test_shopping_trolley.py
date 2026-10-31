from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("shopping_trolley: the prefab spawns and its model's controls work")
async def test_shopping_trolley(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.shopping_trolley, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("child_seat_flap", 45.0)
    assert abs(model.joint("child_seat_flap") - 45.0) < 1e-3
    model.set_option("body", "basket")
    assert model.option("body") == "basket"
    assert model.socket_position("socket_basket").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
