/**
 * ai — game AI (sdk/parallax/ai.pyi): behavior trees with blackboards (data in
 * content/behavior_tree/*.json or built in Python), utility choices and a goal planner as
 * tree nodes, perception (sight cones with occlusion, hearing, memory, awareness levels),
 * squads (shared blackboards, formations, target sharing, cover and flanking), tactical
 * queries, a combat director, RTS unit orders with formations, flocks/shoals, and fog of
 * war. It runs in the kernel's 'physics' hook (state.ts gives the order) and keeps all of
 * its state in its snapshot.
 *
 * Other plugins it uses, through services, looked up at use: nav (movement, static
 * occlusion, opaque cells), physics3d (raycast occlusion). It provides the ai, perception
 * and fog_of_war services. It reads combat's `side` and writes the HUD's `awareness`
 * meter by component id, never importing either plugin.
 */

import { fail } from '../../../core/index.js';
import type { ComponentDef, Kernel, KernelPlugin } from '../../kernel/index.js';
import type { Json } from '../../../resource/index.js';
import { AI_SERVICE, FOG_OF_WAR_SERVICE, PERCEPTION_SERVICE } from '../../services/index.js';
import { AiApi, componentMethods, TaskAgent } from './namespace.js';
import { AI_EVENTS, BRAIN, FLOCK, ORDERS, PERCEPTION, SCHEMAS } from './schemas.js';
import { AiState } from './state.js';
import type { AiOptions } from './state.js';

export { AI_EVENTS, BEHAVIOR_TREE, BRAIN, COVER_POINT, DETECTABLE, FLOCK, ORDERS, PERCEPTION, SCHEMAS, SQUAD_MEMBER, VISION } from './schemas.js';
export { parseTree, NODE_TYPES, OPS } from './tree.js';
export type { Node, Status, TreeDef } from './tree.js';
export { CURVES } from './utility.js';
export { FORMATIONS, formationOffsets, placeSlots, assignSlots } from './formations.js';
export { DIRECTOR_DEFAULTS, DIRECTOR_KEYS, directorSettings } from './director.js';
export { AiApi, BlackboardView, DirectorHandle, FogHandle, SquadHandle, TaskAgent } from './namespace.js';
export type { AiOptions, TaskDef, TreeSource } from './state.js';

export interface AiPlugin extends KernelPlugin {
  /** `ctx.ai` (the api layer mounts it). */
  api(): AiApi;
}

export function ai(options: AiOptions = {}): AiPlugin {
  let state: AiState | undefined;
  const live = (): AiState => state ?? fail('PP9250', 'ai is used before its kernel was built');
  const methods = componentMethods(live);
  const components: ComponentDef[] = Object.entries(SCHEMAS).map(([id, schema]) => {
    const m = id === BRAIN ? methods['brain'] : id === PERCEPTION ? methods['perception'] : id === ORDERS ? methods['orders'] : id === FLOCK ? methods['flock'] : undefined;
    return { id, schema, ...(m !== undefined && { methods: m }) };
  });
  const api = new AiApi(live);
  return {
    id: 'ai',
    components,
    events: Object.values(AI_EVENTS),
    install(k: Kernel) {
      if (state !== undefined) fail('PP3247', 'This ai plugin is already installed in another kernel', { fix: 'Call ai() once per game.' });
      state = new AiState(k, options);
      state.agent = (st, id, brain, node, elapsed, dt) => new TaskAgent(st, id, brain, node, elapsed, dt);
      state.loadTrees();
      k.provide(AI_SERVICE, state.aiService());
      k.provide(PERCEPTION_SERVICE, state.perceptionService());
      k.provide(FOG_OF_WAR_SERVICE, state.fogService());
      k.observeScenes({ loading: (_scene, request) => state!.reset(request.seed ?? 0) });
      k.observeEntities({ removed: (records) => state!.removed(records) });
      k.addHook('physics', (dt) => state!.step(dt));
    },
    api: () => api,
    snapshot: () => live().snapshot(),
    restore: (_k, json: Json) => live().restore(json),
  };
}
