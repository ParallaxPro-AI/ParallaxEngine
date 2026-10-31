from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("flintlock_pistol: the prefab spawns and its model's controls work")
async def test_flintlock_pistol(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.flintlock_pistol, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hammer", 18.0)
    assert abs(model.joint("hammer") - 18.0) < 1e-3
    model.set_option("stock_wood", "oak")
    assert model.option("stock_wood") == "oak"
    assert model.socket_position("socket_muzzle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
