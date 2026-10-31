from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("luxury_dresser: the prefab spawns and its model's controls work")
async def test_luxury_dresser(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.luxury_dresser, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_00", 0.15)
    assert abs(model.joint("drawer_00") - 0.15) < 1e-3
    model.set_option("styling", "bare")
    assert model.option("styling") == "bare"
    assert model.socket_position("surface_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
