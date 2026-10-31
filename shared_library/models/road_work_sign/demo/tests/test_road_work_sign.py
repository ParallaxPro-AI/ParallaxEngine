from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("road_work_sign: the prefab spawns and its model's controls work")
async def test_road_work_sign(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.road_work_sign, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("panel_fold", 41.0)
    assert abs(model.joint("panel_fold") - 41.0) < 1e-3
    model.set_option("message", "detour")
    assert model.option("message") == "detour"
    assert model.socket_position("socket_lamp").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
