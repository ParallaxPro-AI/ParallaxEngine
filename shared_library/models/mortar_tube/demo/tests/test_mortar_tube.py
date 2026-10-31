from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mortar_tube: the prefab spawns and its model's controls work")
async def test_mortar_tube(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mortar_tube, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tube", 1.0)
    assert abs(model.joint("tube") - 1.0) < 1e-3
    model.set_option("finish", "sand")
    assert model.option("finish") == "sand"
    assert model.socket_position("muzzle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
