from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("horse_stable: the prefab spawns and its model's controls work")
async def test_horse_stable(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.horse_stable, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_bottom", 82.5)
    assert abs(model.joint("door_bottom") - 82.5) < 1e-3
    model.set_option("walls", "dark_stain")
    assert model.option("walls") == "dark_stain"
    assert model.socket_position("socket_horse").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
