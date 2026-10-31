from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rice_cooker: the prefab spawns and its model's controls work")
async def test_rice_cooker(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rice_cooker, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 47.5)
    assert abs(model.joint("lid") - 47.5) < 1e-3
    model.set_option("fill", "empty")
    assert model.option("fill") == "empty"
    assert model.socket_position("socket_pot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
