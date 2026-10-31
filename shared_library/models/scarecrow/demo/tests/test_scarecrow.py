from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("scarecrow: the prefab spawns and its model's controls work")
async def test_scarecrow(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.scarecrow, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("legs_swing", 0.0)
    assert abs(model.joint("legs_swing") - 0.0) < 1e-3
    model.set_option("shirt_colour", "blue")
    assert model.option("shirt_colour") == "blue"
    assert model.socket_position("perch_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
