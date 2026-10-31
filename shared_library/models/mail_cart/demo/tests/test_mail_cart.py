from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mail_cart: the prefab spawns and its model's controls work")
async def test_mail_cart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mail_cart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("caster_fl_swivel", 90.0)
    assert abs(model.joint("caster_fl_swivel") - 90.0) < 1e-3
    model.set_option("frame", "black")
    assert model.option("frame") == "black"
    assert model.socket_position("socket_shelf").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
