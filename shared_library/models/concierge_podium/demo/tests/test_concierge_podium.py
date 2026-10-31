from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("concierge_podium: the prefab spawns and its model's controls work")
async def test_concierge_podium(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.concierge_podium, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cupboard_door", 55.0)
    assert abs(model.joint("cupboard_door") - 55.0) < 1e-3
    model.set_option("wood", "ebony")
    assert model.option("wood") == "ebony"
    assert model.socket_position("staff_spot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
