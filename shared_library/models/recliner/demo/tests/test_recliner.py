from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("recliner: the prefab spawns and its model's controls work")
async def test_recliner(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.recliner, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("recline", 16.0)
    assert abs(model.joint("recline") - 16.0) < 1e-3
    model.set_option("upholstery", "black_leather")
    assert model.option("upholstery") == "black_leather"
    assert model.socket_position("socket_seat").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
