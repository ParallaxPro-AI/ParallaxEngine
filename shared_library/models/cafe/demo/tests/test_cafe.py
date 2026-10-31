from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cafe: the prefab spawns and its model's controls work")
async def test_cafe(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cafe, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pastry_case_glass_left", 0.285)
    assert abs(model.joint("pastry_case_glass_left") - 0.285) < 1e-3
    model.set_option("facade_colour", "sage")
    assert model.option("facade_colour") == "sage"
    assert model.socket_position("socket_entrance").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
