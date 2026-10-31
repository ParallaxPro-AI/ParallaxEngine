from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("treehouse: the prefab spawns and its model's controls work")
async def test_treehouse(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.treehouse, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hut_door", 50.0)
    assert abs(model.joint("hut_door") - 50.0) < 1e-3
    model.set_option("hut_colour", "green")
    assert model.option("hut_colour") == "green"
    assert model.socket_position("socket_ladder_foot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
