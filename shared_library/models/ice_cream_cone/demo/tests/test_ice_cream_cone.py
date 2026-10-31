from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ice_cream_cone: the prefab spawns and its model's controls work")
async def test_ice_cream_cone(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ice_cream_cone, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("topping", "plain")
    assert model.option("topping") == "plain"
    assert model.socket_position("socket_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
