from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ammo_crate: the prefab spawns and its model's controls work")
async def test_ammo_crate(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ammo_crate, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 50.0)
    assert abs(model.joint("lid") - 50.0) < 1e-3
    model.set_option("calibre_stencil", "white")
    assert model.option("calibre_stencil") == "white"
    assert model.socket_position("socket_interior").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
