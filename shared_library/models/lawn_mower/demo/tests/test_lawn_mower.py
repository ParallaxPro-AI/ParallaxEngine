from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("lawn_mower: the prefab spawns and its model's controls work")
async def test_lawn_mower(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.lawn_mower, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bail", 13.0)
    assert abs(model.joint("bail") - 13.0) < 1e-3
    model.set_option("deck_colour", "red")
    assert model.option("deck_colour") == "red"
    assert model.socket_position("socket_handle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
