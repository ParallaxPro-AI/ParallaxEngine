from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("road_t_junction: the prefab spawns and its model's controls work")
async def test_road_t_junction(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.road_t_junction, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("markings", "double_yellow")
    assert model.option("markings") == "double_yellow"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
