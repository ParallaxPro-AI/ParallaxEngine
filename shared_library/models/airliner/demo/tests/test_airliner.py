from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("airliner: the prefab spawns and its model's controls work")
async def test_airliner(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.airliner, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flap_l", 20.0)
    assert abs(model.joint("flap_l") - 20.0) < 1e-3
    model.set_option("livery", "red")
    assert model.option("livery") == "red"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
