import type { HarnessQuestion } from "../../../shared/tabs";
import { object, string } from "../json";

// Maps a flat MCP form of string, number, boolean, and enum fields onto question cards.
export function elicitationQuestions(params: Record<string, unknown>) {
  if (params.mode !== "form") return null;
  const schema = object(params.requestedSchema);
  const properties = Object.entries(object(schema.properties));
  if (!properties.length || properties.length > 10) return null;
  const fields: Record<string, string> = {};
  const questions: HarnessQuestion[] = [];
  for (const [id, value] of properties) {
    const property = object(value);
    const options = Array.isArray(property.enum)
      ? property.enum.map((option, index) => ({
          label:
            string(
              Array.isArray(property.enumNames)
                ? property.enumNames[index]
                : "",
            ) || String(option),
          description: "",
        }))
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
    fields[id] = string(property.type);
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
  fields: Record<string, string>,
) {
  return Object.fromEntries(
    Object.entries(answers).map(([id, [value = ""]]) => [
      id,
      fields[id] === "boolean"
        ? value === "true"
        : ["number", "integer"].includes(fields[id])
          ? Number(value)
          : value,
    ]),
  );
}
