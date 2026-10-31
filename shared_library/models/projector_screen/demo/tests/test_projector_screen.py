from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("projector_screen: the prefab spawns and its model's controls work")
async def test_projector_screen(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.projector_screen, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("screen_roll", 0.515)
    assert abs(model.joint("screen_roll") - 0.515) < 1e-3
    model.set_option("image", "projecting")
    assert model.option("image") == "projecting"
    assert model.socket_position("socket_image").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
