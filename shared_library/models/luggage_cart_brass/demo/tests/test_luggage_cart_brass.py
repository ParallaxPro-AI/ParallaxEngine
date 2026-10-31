from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("luggage_cart_brass: the prefab spawns and its model's controls work")
async def test_luggage_cart_brass(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.luggage_cart_brass, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("metal", "nickel")
    assert model.option("metal") == "nickel"
    assert model.socket_position("deck_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
