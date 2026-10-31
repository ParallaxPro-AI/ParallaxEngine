from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("barn_door: the prefab spawns and its model's controls work")
async def test_barn_door(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.barn_door, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_slide", 0.45)
    assert abs(model.joint("door_slide") - 0.45) < 1e-3
    model.set_option("plank_pattern", "vertical")
    assert model.option("plank_pattern") == "vertical"
    assert model.socket_position("socket_handle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
