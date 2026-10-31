"""Save version 3: story facts are snake_case (as .yarn names them), and countdowns are `Timer` records."""

from parallax import SaveData, migration

QUESTS = ("welcome_hero", "goblin_menace", "restless_barrow", "shaman_circle", "ironhold", "shadow_dungeon")
RIFT_SECONDS = 360
"""The rift's duration in config/shadow_rift.json when version 2 shipped."""
EMBER_REVIVE_SECONDS = 14


def timer(duration: float, remaining: float) -> dict[str, object]:
    """A `Timer` in its saved JSON form (documented on `SaveData`)."""
    return {"duration": duration, "remaining": remaining, "repeat": False}


@migration(from_version=2, to_version=3)
def facts_and_timers(save: SaveData) -> None:
    for quest in QUESTS:
        save.facts[f"{quest}_done"] = save.facts.pop(f"quest.{quest}.done", False)
    save.facts.pop("story.begun", None)

    doom = save.resources["doom"]
    running = doom.pop("deadline", None) is not None
    elapsed = doom.pop("elapsed", 0)
    doom["clock"] = timer(RIFT_SECONDS, max(0, RIFT_SECONDS - elapsed) if running else 0)

    hero = save.entities.get("hero")
    if hero is not None:
        hero.pop("evasion", None)
        hero.pop("defense", None)
    companion = save.entities.get("ember", {}).get("companion")
    if companion is not None and "revive_in" in companion:
        companion["revive"] = timer(EMBER_REVIVE_SECONDS, companion.pop("revive_in"))
