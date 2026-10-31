/**
 * resource — loading a project's data files (prefabs, scenes and world regions, config,
 * content, locale, audio defaults) into a validated, read-only `Project`, through the
 * `ProjectFiles` port. Imports only `core`.
 *
 * Validated here: JSON syntax, the shape of every file kind (unknown keys included), id
 * naming, duplicate ids, and every reference between data files. Validated later by
 * `parallax check`, which also has the compiled game: component, behavior, panel and tag
 * ids, and component fields against their schemas.
 */

export { loadProject } from './load_project.js';
export { resolvePrefab } from './variants.js';
export { mergeJson, withoutDeletions } from './merge.js';
export type { ResolvedPrefab } from './variants.js';
export type {
  AudioDefaults, AudioLevel, BehaviorUse, ConfigDoc, ContentEntry, FeatureId, InstanceFields, InstanceGrid,
  Json, JsonObject, LocaleDoc, Origin, Placement, PrefabChild, PrefabDoc, Project, RegionDoc, SceneDoc, WorldDoc,
  WorldLayerDoc,
} from './model.js';
export { decodeBuffer, encodeBuffer, parseModelDocument } from './models/parse.js';
export { BUILTIN_MODELS, BUILTIN_PREFIX, FP_ARMS, FP_ARMS_IK, proceduralArmsDocument } from './models/procedural_arms.js';
export type { ParsedModel } from './models/parse.js';
export { MODEL_DOCUMENT, MODEL_FORMAT, MODEL_SHAPES, MODEL_VERSION } from './models/format.js';
export type {
  JointType, MaterialOverride, ModelBone, ModelDocument, ModelJoint, ModelMaterial, ModelMesh, ModelOption, ModelParent, ModelPart, ModelShape,
  ModelSkeleton, ModelSocket,
} from './models/format.js';
export {
  checkChoice, chosenMaterial, clampJoint, declaredSocket, easeJoint, JOINT_EASE, jointNamed, jointValue, materialNamed, optionNamed, partNamed,
  shownParts,
} from './models/rig.js';
export type { JointMotion } from './models/rig.js';
export * from './bundles/index.js';
export { AssetCatalog, assetHandle, handleFormProblem, refString, remoteRef, requireHandleForm, splitClip } from './asset_catalog.js';
export type { AssetFolder } from './asset_catalog.js';
export * from './models/gltf.js';
export * from './models/code_model.js';
export * from './models/primitives.js';
export * from './models/matrix.js';
export * from './models/code_model_pose.js';
export * from './models/animation.js';
export {
  add3, getRotation, getTranslation, IDENTITY_Q, len3, nodePosition, norm3, qangle, qeuler, qfromTo, qinv, qmul, qnormalize, qrotate,
  qslerp, qtwistY, qyaw, scale3, setRotation, setTranslation, sub3, worldRotations,
} from './models/animation_math.js';
export type { Q, V3 } from './models/animation_math.js';
