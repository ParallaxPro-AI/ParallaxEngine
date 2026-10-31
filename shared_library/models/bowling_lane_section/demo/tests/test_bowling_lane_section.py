from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bowling_lane_section: the prefab spawns and its model's controls work")
async def test_bowling_lane_section(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bowling_lane_section, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("wood", "dark")
    assert model.option("wood") == "dark"
    assert model.socket_position("bowler").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
