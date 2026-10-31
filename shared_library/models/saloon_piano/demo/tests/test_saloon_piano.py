from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("saloon_piano: the prefab spawns and its model's controls work")
async def test_saloon_piano(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.saloon_piano, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fallboard", 48.0)
    assert abs(model.joint("fallboard") - 48.0) < 1e-3
    model.set_option("finish", "walnut")
    assert model.option("finish") == "walnut"
    assert model.socket_position("seat_stool").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
