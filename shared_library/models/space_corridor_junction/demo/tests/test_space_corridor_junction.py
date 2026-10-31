from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("space_corridor_junction: the prefab spawns and its model's controls work")
async def test_space_corridor_junction(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.space_corridor_junction, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("layout", "tee")
    assert model.option("layout") == "tee"
    assert model.socket_position("socket_arm_front").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
