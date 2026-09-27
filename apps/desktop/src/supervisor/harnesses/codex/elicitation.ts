import type { HarnessQuestion } from "../../../shared/tabs";
import { object, string } from "../json";

// A form field's type, and for enums the value behind each shown label.
export interface ElicitationField {
  type: string;
  values?: Record<string, unknown>;
}

// Maps a flat MCP form of string, number, boolean, and enum fields onto question cards.
export function elicitationQuestions(params: Record<string, unknown>) {
  if (params.mode !== "form") return null;
  const schema = object(params.requestedSchema);
  const properties = Object.entries(object(schema.properties));
  if (!properties.length || properties.length > 10) return null;
  const fields: Record<string, ElicitationField> = {};
  const questions: HarnessQuestion[] = [];
  for (const [id, value] of properties) {
    const property = object(value);
    // Enums come as `enum` (optionally titled by `enumNames`) or as titled `oneOf` constants.
    const choices: [string, unknown][] = Array.isArray(property.enum)
      ? property.enum.map((option, index) => [
          string(
            Array.isArray(property.enumNames) ? property.enumNames[index] : "",
          ) || String(option),
          option,
        ])
      : Array.isArray(property.oneOf)
        ? property.oneOf.map((raw) => {
            const option = object(raw);
            return [string(option.title) || String(option.const), option.const];
          })
        : [];
    const options = choices.length
      ? choices.map(([label]) => ({ label, description: "" }))
      : property.type === "boolean"
        ? [
            { label: "true", description: "Yes" },
            { label: "false", description: "No" },
          ]
        : [];
    if (
      !["string", "number", "integer", "boolean"].includes(
        string(property.type),
      )
    )
      return null;
    fields[id] = {
      type: string(property.type),
      ...(choices.length ? { values: Object.fromEntries(choices) } : {}),
    };
    questions.push({
      id,
      header: string(property.title) || id,
      question:
        string(property.description) ||
        string(property.title) ||
        string(params.message) ||
        id,
      options,
      multiSelect: false,
      allowOther: !options.length,
      secret: false,
    });
  }
  return { questions, fields };
}

export function elicitationContent(
  answers: Record<string, string[]>,
  fields: Record<string, ElicitationField>,
) {
  return Object.fromEntries(
    Object.entries(answers).map(([id, [value = ""]]) => {
      const field = fields[id];
      const values = field?.values;
      return [
        id,
        values && Object.hasOwn(values, value)
          ? values[value]
          : field?.type === "boolean"
            ? value === "true"
            : ["number", "integer"].includes(field?.type ?? "")
              ? Number(value)
              : value,
      ];
    }),
  );
}
