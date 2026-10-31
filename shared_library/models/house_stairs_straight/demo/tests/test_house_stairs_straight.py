from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("house_stairs_straight: the prefab spawns and its model's controls work")
async def test_house_stairs_straight(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.house_stairs_straight, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cupboard_door", 47.5)
    assert abs(model.joint("cupboard_door") - 47.5) < 1e-3
    model.set_option("wood", "walnut")
    assert model.option("wood") == "walnut"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
