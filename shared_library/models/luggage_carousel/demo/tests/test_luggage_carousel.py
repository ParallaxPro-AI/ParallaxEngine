from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("luggage_carousel: the prefab spawns and its model's controls work")
async def test_luggage_carousel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.luggage_carousel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("plates", 0.15)
    assert abs(model.joint("plates") - 0.15) < 1e-3
    model.set_option("load", "empty")
    assert model.option("load") == "empty"
    assert model.socket_position("socket_pickup").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
