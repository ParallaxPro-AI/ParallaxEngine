"""Net plugin: server-authoritative online multiplayer.

Model:
- The same game code runs on the server; clients predict and render.
- Systems run on the server by default (`@system(..., runs_on=...)`).
- Behaviors run on the server. In a behavior on a player-owned entity, `ctx.input`
  reads THAT player's input, so player behaviors are written like single-player code.
- Prediction: behaviors listed in `net(predict=[...])` also run on the owning player's
  client, on that player's own entities only, reading the local input — so walking,
  steering and jumping answer at once. The server stays the authority: its result
  corrects the client smoothly (a big difference, like a respawn, snaps). Predict the
  behaviors that MOVE the player; anything that spawns, damages or scores stays
  server-only. What a predicted behavior reads (its `when=`, configs, fields) must be
  on the client too (replicated or data).
- Everyone else's moving entities are drawn slightly in the past, interpolated between
  server snapshots (`net(interpolation=)`; adaptive by default, about two ticks).
- Lag compensation: `ctx.net.raycast(player, ...)` tests a shot against moving entities
  where that player saw them when they fired (inside an @rpc, the view at the call).
- State sync is declared on data: `field(..., replicate=True|"owner"|"team")`.
  Transforms of entities with a Rigidbody, Character or `replicate_transform: true`
  in the prefab replicate automatically.
- Feedback needs no special code: `ctx.audio.play`, `ctx.vfx.play`, `ctx.ui.toast`
  etc. called on the server are forwarded to the relevant clients (`to=player` for one).
- Client → server calls are typed RPCs, usable directly as panel actions.
- Visibility: `net(visible=fn)` decides which entities each player receives (fog of war).
- There is no per-player storage: a `keep="profile"` resource is one shared instance
  on the server (`ctx.get(R, player=)` returns that same instance). Keep per-player
  data in components on the player's entity.
- A match starts with its players assigned. They get there through the platform
  (invites, matchmaking) or the game's own lobby, `ctx.net.lobby`: list rooms, host one
  (name, size, private, mode, map), join by code, ready up and pick teams; the host's
  `start()` moves every member into the match (`MatchStarting`). The host's game keeps
  running and takes the members; each joiner's game becomes the match's client. A
  player's browser can host (`mode="host"`, over WebRTC); a dedicated server is the
  same game, headless.
- A player whose connection drops keeps their seat and entity for `net(rejoin=)`
  seconds (`PlayerRejoined` when they return; `PlayerLeft` when the window ends, or at
  once when they leave on purpose).
- Modal panels never freeze time in a networked game.
"""

from typing import Any, Callable, Sequence, TypeVar
from parallax import Entity, Player, Vec3, event
from parallax.physics import Layer, RayHit

Fn = TypeVar("Fn", bound=Callable[..., Any])

def rpc(id: str, *, rate_limit: float | None = None) -> Callable[[Fn], Fn]:
    """A client → server call: `def buy(ctx, player: Player, item: ContentRef[ItemDef])`.
    As a panel action, `data-*` attributes / list item fields fill the args."""

@event("player_joined")
class PlayerJoined:
    player: Player

@event("player_left")
class PlayerLeft:
    player: Player

@event("player_rejoined")
class PlayerRejoined:
    """A dropped player came back within the rejoin window: same seat, same entity."""
    player: Player

@event("lobby_changed")
class LobbyChanged:
    """The lobby changed: the room listing, this room's members (ready, team), a refusal,
    or the room itself (closed by its host: `ctx.net.lobby.room` is None)."""

@event("match_starting")
class MatchStarting:
    """The host started the room's match. Heard by every member; the match follows (a
    joiner's game is replaced by the match's client at the end of this frame)."""
    code: str
    seat: int

class RoomListing:
    """A room as `ctx.net.lobby.rooms()` lists it (private rooms are not listed)."""
    code: str
    name: str
    players: int
    max_players: int
    private: bool
    mode: str
    map: str
    started: bool
    @property
    def open(self) -> bool:
        """Not started and not full."""

class LobbyPlayer:
    """A room member. Seat 0 is the host."""
    seat: int
    name: str
    ready: bool
    team: str | None
    is_host: bool
    is_you: bool

class LobbyApi:
    """`ctx.net.lobby`: rooms before the match, on the platform's lobby service (the browser:
    `?net=lobby&signal=ws://…`; playtests: an in-memory lobby). Without one, PP3368."""
    def rooms(self) -> list[RoomListing]:
        """The newest public listing (the first call asks for one; `LobbyChanged` follows)."""
    def refresh(self) -> None:
        """Ask for a fresh listing."""
    def host(self, *, name: str, max_players: int | None = None, private: bool = False,
             mode: str = "", map: str = "", player_name: str | None = None) -> None:
        """Open a room (max_players defaults to `net(max_players=)`, and may not exceed it)."""
    def join(self, code: str, *, player_name: str | None = None) -> None:
        """Join by code. A refusal (no such room, full, started) is `error`, with `LobbyChanged`."""
    @property
    def available(self) -> bool:
        """This run has a lobby service (False: start the match directly)."""
    @property
    def room(self) -> RoomListing | None: ...
    @property
    def code(self) -> str | None: ...
    @property
    def in_room(self) -> bool: ...
    @property
    def is_host(self) -> bool: ...
    @property
    def seat(self) -> int | None: ...
    @property
    def players(self) -> list[LobbyPlayer]:
        """Members by seat. After the start, kept as they were (match seats and teams by name)."""
    @property
    def all_ready(self) -> bool: ...
    @property
    def started(self) -> bool: ...
    @property
    def error(self) -> str | None:
        """The last refused request's message, cleared by the next accepted one."""
    def set_ready(self, ready: bool = True) -> None: ...
    def set_team(self, team: str | None) -> None: ...
    def start(self) -> None:
        """Host only (PP3367): every member moves into the networked match."""
    def leave(self) -> None:
        """Leave the room (the host leaving closes it). Not after the start (PP3366)."""

VisibleFn = Callable[[Any, Player, Entity], bool]
"""`def visible(ctx, player, entity) -> bool` — evaluated by the server's interest system.

Fog of war with `ai()`: send an entity to a player when their team can see it (the
team's own units always pass: they reveal the fog around themselves)::

    def visible(ctx, player, e):
        team = player.entity.get(Side).side
        return ctx.ai.fog.sees(team, e)

    Game(plugins=[ai(fog_cell=2), net(visible=visible, ...)])
"""

class NetApi:
    lobby: LobbyApi
    @property
    def is_server(self) -> bool: ...
    @property
    def local_player(self) -> Player | None: ...
    def call(self, rpc: Callable[..., Any], **args: Any) -> None:
        """Client: invoke an RPC from code (panels can bind RPCs directly)."""
    def respawn(self, player: Player, *, at: Entity | None = None) -> Entity: ...
    def team_of(self, player: Player) -> str | None: ...
    def raycast(self, player: Player, origin: Vec3, direction: Vec3, max_distance: float = 1000,
                *, layers: Sequence[Layer] = (), ignore: Sequence[Entity] = ()) -> RayHit | None:
        """Server: a lag-compensated `ctx.physics.raycast` — entities whose transform
        replicates are tested where `player` saw them (rewound up to `net(rewind=)`
        seconds), the static world as it is now. 3D games."""
    def seen_position(self, entity: Entity, player: Player) -> Vec3:
        """Server: where `player`'s screen showed `entity` (for hit tests of your own:
        melee arcs, areas)."""
