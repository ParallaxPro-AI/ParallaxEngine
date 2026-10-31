from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ray_gun_retro: the prefab spawns and its model's controls work")
async def test_ray_gun_retro(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ray_gun_retro, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("trigger", 9.0)
    assert abs(model.joint("trigger") - 9.0) < 1e-3
    model.set_option("energy", "cyan")
    assert model.option("energy") == "cyan"
    assert model.socket_position("socket_muzzle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
