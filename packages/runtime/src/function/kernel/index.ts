/**
 * function/kernel — the engine proper: the world (entities, components, tags, transforms,
 * hierarchy, queries), instantiation from loaded prefabs and scenes, the frame loop and
 * its phases, time, timers, events, scoping (`scenes=` / `when=`), resources and scene
 * changes, snapshot/restore and resource saves. Plugins extend it through definitions and
 * hook points; it never imports a plugin. Imports `core` and `resource`.
 */

export { Kernel, KERNEL_EVENTS, serviceKey } from './kernel.js';
export type {
  EntityHandles, EntityLifecycle, HookPoint, KernelOptions, SceneLifecycle, SceneRequest, ServiceKey, SpawnRequest, Time,
} from './kernel.js';
export { COMPONENT_ENTITY, componentEntity } from './definitions.js';
export type {
  BehaviorDef, ComponentDef, Condition, Context, EventDef, GameDefinition, GameEvent, Handler,
  KernelPlugin, LogicInstance, ResourceDef, SceneScope, SystemDef,
} from './definitions.js';
export { copy, COPY, decode, decodeFields, encode, encodeFields, instantiate, t } from './schema.js';
export type { EntityCodec, Fields, FieldSpec, FieldType, Keep, Schema } from './schema.js';
export { FRAME_PHASES } from './probe.js';
export type { FramePhase, FrameSample, HookSample, KernelProbe, UnitSample } from './probe.js';
export { SNAPSHOT_FORMAT } from './snapshot.js';
export type {
  BehaviorSnapshot, EntitySnapshot, FieldsSnapshot, ResourceSave, SavedModifier, Snapshot, TimeSnapshot, TransformSnapshot,
} from './snapshot.js';
export type { Overrides } from './spawner.js';
export type { ModifierInit, ModifierState } from './modifiers.js';
export { waits } from './tasks.js';
export type { TaskBody, Wait } from './tasks.js';
export type { Handle, Owner } from './timers.js';
export { TransformNode } from './transform.js';
export type { BehaviorSlot, EntityRecord, IdState, QueryFilter, World } from './world.js';
