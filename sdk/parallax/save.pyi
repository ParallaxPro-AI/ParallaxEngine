"""Save plugin. A slot holds: keep="run" resource fields (and their modifiers), the current
scene and its seed, an id-keyed diff of placed entities, the environment's run state and
plugin sections (facts, quests). Not saved: keep="session"/"scene" fields, entities spawned
at runtime, running timers and tasks. keep="profile" fields persist on the device without
this plugin. There is no autosave: the game calls `ctx.save.save(slot)` itself."""

from parallax import SceneRef


class SaveInfo:
    """What a slot shows on a save menu, read without loading it (`ctx.save.info(slot)`)."""
    slot: str
    scene: SceneRef
    """The scene that was current."""
    play_time: float
    """Seconds of game time played in the run (a new_run=True load starts a new run; loading
    a slot continues its play time; time frozen by a pause doesn't count)."""
    saved_at: float | None
    """Wall-clock Unix seconds it was written; None where the platform has no clock
    (headless playtests). For display only."""
    label: str
    """`save(slot, label=...)`; "" when none."""
    order: int
    """Higher for every later save on this device: the newest slot has the highest."""


class SaveApi:
    def save(self, slot: str = "auto", *, label: str = "") -> None:
        """Write the run to a slot, with its info (scene, play time, now, `label`)."""
    def info(self, slot: str = "auto") -> SaveInfo | None:
        """The slot's info, or None when it's empty."""
    def load(self, slot: str = "auto") -> bool:
        """Loads the slot's scene and state. False if the slot is empty."""
    def exists(self, slot: str = "auto") -> bool: ...
    def delete(self, slot: str) -> None: ...
    def slots(self) -> list[str]: ...
    def checkpoint(self) -> None:
        """Snapshot the run so `restore_checkpoint` can return here (death/retry)."""
    def restore_checkpoint(self) -> bool: ...
