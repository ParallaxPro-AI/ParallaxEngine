from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("skate_rail_grind: the prefab spawns and its model's controls work")
async def test_skate_rail_grind(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.skate_rail_grind, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("rail", 0.01)
    assert abs(model.joint("rail") - 0.01) < 1e-3
    model.set_option("rail", "red")
    assert model.option("rail") == "red"
    assert model.socket_position("socket_rail_start").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
