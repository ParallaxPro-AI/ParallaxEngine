from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dslr_camera: the prefab spawns and its model's controls work")
async def test_dslr_camera(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dslr_camera, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flash", 29.0)
    assert abs(model.joint("flash") - 29.0) < 1e-3
    model.set_option("colour", "silver")
    assert model.option("colour") == "silver"
    assert model.socket_position("socket_lens").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
