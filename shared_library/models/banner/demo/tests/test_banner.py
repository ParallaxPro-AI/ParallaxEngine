from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("banner: the prefab spawns and its model's controls work")
async def test_banner(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.banner, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pole", 90.0)
    assert abs(model.joint("pole") - 90.0) < 1e-3
    model.set_option("heraldry", "lozenge")
    assert model.option("heraldry") == "lozenge"
    assert model.socket_position("socket_finial").distance_to(thing.transform.position) < 4.29
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
