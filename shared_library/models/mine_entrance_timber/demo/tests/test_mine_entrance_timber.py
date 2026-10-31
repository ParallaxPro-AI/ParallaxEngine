from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mine_entrance_timber: the prefab spawns and its model's controls work")
async def test_mine_entrance_timber(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mine_entrance_timber, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 52.5)
    assert abs(model.joint("door_l") - 52.5) < 1e-3
    model.set_option("doors", "none")
    assert model.option("doors") == "none"
    assert model.socket_position("mouth").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
