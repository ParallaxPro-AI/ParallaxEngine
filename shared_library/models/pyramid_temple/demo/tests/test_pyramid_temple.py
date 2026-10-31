from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pyramid_temple: the prefab spawns and its model's controls work")
async def test_pyramid_temple(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pyramid_temple, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 47.5)
    assert abs(model.joint("door_l") - 47.5) < 1e-3
    model.set_option("stone_colour", "limestone")
    assert model.option("stone_colour") == "limestone"
    assert model.socket_position("socket_altar").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
