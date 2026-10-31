from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("trophy_case: the prefab spawns and its model's controls work")
async def test_trophy_case(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.trophy_case, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("slide_l", 0.3)
    assert abs(model.joint("slide_l") - 0.3) < 1e-3
    model.set_option("backing", "navy")
    assert model.option("backing") == "navy"
    assert model.socket_position("shelf_low").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
