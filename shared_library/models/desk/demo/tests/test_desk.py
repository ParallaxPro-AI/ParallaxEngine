from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("desk: the prefab spawns and its model's controls work")
async def test_desk(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.desk, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer", 0.16)
    assert abs(model.joint("drawer") - 0.16) < 1e-3
    model.set_option("style", "school")
    assert model.option("style") == "school"
    assert model.socket_position("socket_desktop").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
