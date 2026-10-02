import { HARNESS_LABELS, type Loadout } from "../../shared/tabs";
import type { HarnessRegistry } from "../harnesses/registry";

/** The loadout with the harness's default model and effort filled in, once its models are known. */
export function withDefaultModel(
  registry: HarnessRegistry,
  loadout: Loadout,
): Loadout {
  const models = registry.state(loadout.harness).models;
  // A chosen model keeps its place and only a missing effort is filled in.
  const model = loadout.model
    ? models.find((model) => model.id === loadout.model)
    : (models.find((model) => model.isDefault) ?? models[0]);
  if (!model || (loadout.model && loadout.effort)) return loadout;
  const effort =
    model.defaultEffort && model.efforts.includes(model.defaultEffort)
      ? model.defaultEffort
      : model.efforts[0];
  return { ...loadout, model: model.id, ...(effort ? { effort } : {}) };
}

export function validateLoadout(registry: HarnessRegistry, loadout: Loadout) {
  const models = registry.state(loadout.harness).models;
  if (!models.length) return;
  const model = models.find((model) => model.id === loadout.model);
  if (!model)
    throw new Error(
      `${loadout.model || "The selected model"} is not offered by ${HARNESS_LABELS[loadout.harness]} right now. Choose a model again.`,
    );
  if (
    loadout.effort &&
    model.efforts.length &&
    !model.efforts.includes(loadout.effort)
  )
    throw new Error(`${model.name} does not support ${loadout.effort} effort.`);
}
