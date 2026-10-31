from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cooking_pot: the prefab spawns and its model's controls work")
async def test_cooking_pot(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cooking_pot, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 0.06)
    assert abs(model.joint("lid") - 0.06) < 1e-3
    model.set_option("lid", "steel")
    assert model.option("lid") == "steel"
    assert model.socket_position("socket_contents").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
