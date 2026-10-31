from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("stair_climber: the prefab spawns and its model's controls work")
async def test_stair_climber(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.stair_climber, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steps", 0.1601)
    assert abs(model.joint("steps") - 0.1601) < 1e-3
    model.set_option("shroud", "silver")
    assert model.option("shroud") == "silver"
    assert model.socket_position("stand_user").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
