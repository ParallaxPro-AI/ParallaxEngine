from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("harpoon_gun: the prefab spawns and its model's controls work")
async def test_harpoon_gun(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.harpoon_gun, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("trigger", 10.0)
    assert abs(model.joint("trigger") - 10.0) < 1e-3
    model.set_option("barrel_colour", "black")
    assert model.option("barrel_colour") == "black"
    assert model.socket_position("socket_muzzle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
