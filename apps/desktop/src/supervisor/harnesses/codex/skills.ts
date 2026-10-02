import { object, string } from "../json";
import type { JsonRpcTransport } from "./transport";

export interface CodexSkill {
  name: string;
  description: string;
  path: string;
}

/** The enabled skills Codex finds for a working directory. */
export async function listSkills(
  transport: JsonRpcTransport,
  cwd: string,
): Promise<CodexSkill[]> {
  const response = object(
    await transport.request("skills/list", { cwds: [cwd] }, 10_000),
  );
  const entries = (Array.isArray(response.data) ? response.data : []).map(
    object,
  );
  const entry = entries.find((item) => string(item.cwd) === cwd) ?? entries[0];
  return (Array.isArray(entry?.skills) ? entry.skills : [])
    .map(object)
    .filter((skill) => skill.enabled !== false)
    .map((skill) => ({
      name: string(skill.name),
      description:
        string(object(skill.interface).shortDescription) ||
        string(skill.shortDescription) ||
        string(skill.description),
      path: string(skill.path),
    }))
    .filter((skill) => skill.name && skill.path);
}
