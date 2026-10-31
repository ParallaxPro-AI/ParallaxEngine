"""Save version 2: facts are snake_case (as .yarn names them), the vest is `Health.shield`, and jobs are quests.

Version 1 kept finished contracts in a `contracts` resource (`completed`: contract ids). They become
completed quests, so they stay off the board.
"""

from parallax import SaveData, migration


@migration(from_version=1, to_version=2)
def jobs_become_quests(save: SaveData) -> None:
    save.facts["contracts_completed"] = save.facts.pop("contracts.completed", 0)
    save.facts["permit_owned"] = save.facts.pop("contracts.permit", False)
    for contract in save.resources.pop("contracts", {}).get("completed", []):
        save.quests[contract] = {"status": "completed", "active_steps": [], "completed_steps": [], "progress": {}}

    player = save.entities.get("player")
    if player is not None and "armour" in player:
        vest = player.pop("armour")
        player.setdefault("health", {})["shield"] = vest.get("points", 0)
        if "max" in vest:
            player["armour"] = {"capacity": vest["max"]}
