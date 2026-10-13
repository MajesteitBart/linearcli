import { readFile } from "node:fs/promises";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv2019 } from "ajv/dist/2019.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CliError } from "./errors.js";
export type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  [key: string]: unknown;
};
const validationOptions = {
  strict: false,
  allErrors: true,
  validateFormats: false,
};
const ajv = new Ajv(validationOptions);
const ajv2020 = new Ajv2020(validationOptions);
const ajv2019 = new Ajv2019(validationOptions);
function normalize(name: string) {
  return name.replace(/[-_]/g, "").toLowerCase();
}
function schemaType(schema: Schema, value: string): string | undefined {
  const type = schema.type;
  if (typeof type === "string") return type;
  const choices = [
    ...(Array.isArray(type) ? type : []),
    ...(schema.anyOf || schema.oneOf || []).flatMap((s) =>
      typeof s.type === "string" ? [s.type] : [],
    ),
  ];
  if (choices.includes("null") && value === "null") return "null";
  if (choices.includes("object") && value.startsWith("{")) return "object";
  if (choices.includes("array") && value.startsWith("[")) return "array";
  if (choices.includes("string")) return "string";
  return choices.find((t) => t !== "null");
}
function convert(raw: string, schema: Schema, field: string): unknown {
  const type = schemaType(schema, raw);
  if (type === "string") return raw;
  if (type === "boolean") {
    if (raw !== "true" && raw !== "false")
      throw new CliError("INVALID_ARGUMENT", `${field} must be true or false.`);
    return raw === "true";
  }
  if (type === "integer" || type === "number") {
    if (!raw.trim())
      throw new CliError("INVALID_ARGUMENT", `${field} must be a number.`);
    const num = Number(raw);
    if (!Number.isFinite(num) || (type === "integer" && !Number.isInteger(num)))
      throw new CliError("INVALID_ARGUMENT", `${field} must be ${type}.`);
    return num;
  }
  if (type === "array" && !raw.startsWith("["))
    return [convert(raw, schema.items || { type: "string" }, field)];
  if (type === "object" || type === "array" || type === "null") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new CliError("INVALID_ARGUMENT", `${field} requires valid JSON.`);
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
async function stdin() {
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 10_000_000)
      throw new CliError("INPUT_TOO_LARGE", "JSON input exceeds 10 MB.");
  }
  return value;
}
async function objectInput(
  value: string,
  file: boolean,
): Promise<Record<string, unknown>> {
  const raw =
    value === "-"
      ? await stdin()
      : file
        ? await readFile(value, "utf8")
        : value;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CliError("INVALID_JSON", "Tool arguments must be valid JSON.");
  }
  if (!data || Array.isArray(data) || typeof data !== "object")
    throw new CliError("INVALID_JSON", "Tool arguments must be a JSON object.");
  return data as Record<string, unknown>;
}
export async function argumentsFor(
  tool: Tool,
  tokens: string[],
  positional = false,
) {
  const schema = tool.inputSchema as Schema;
  const properties = schema.properties || {};
  const args: Record<string, unknown> = {};
  let dryRun = false;
  const positions: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--data" || token === "--data-file") {
      const value = tokens[++i];
      if (value === undefined)
        throw new CliError("INVALID_ARGUMENT", `${token} requires a value.`);
      Object.assign(args, await objectInput(value, token === "--data-file"));
      continue;
    }
    if (!token.startsWith("--")) {
      positions.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const key = token.slice(2, equals < 0 ? undefined : equals);
    const field = Object.keys(properties).find(
      (field) => normalize(field) === normalize(key),
    );
    if (!field)
      throw new CliError(
        "UNKNOWN_ARGUMENT",
        `Unknown field ${key} for ${tool.name}. Run linear tools show ${tool.name} for its schema.`,
      );
    const definition = properties[field];
    let raw = equals < 0 ? undefined : token.slice(equals + 1);
    if (raw === undefined) {
      if (
        schemaType(definition, "") === "boolean" &&
        (tokens[i + 1] === undefined || tokens[i + 1].startsWith("--"))
      )
        raw = "true";
      else {
        raw = tokens[++i];
        if (raw === undefined || raw.startsWith("--"))
          throw new CliError(
            "INVALID_ARGUMENT",
            `${token} requires a value (use --field=value for values beginning with --).`,
          );
      }
    }
    const value = convert(raw, definition, field);
    args[field] =
      Array.isArray(value) && Array.isArray(args[field])
        ? [...(args[field] as unknown[]), ...value]
        : value;
  }
  if (positions.length) {
    if (!positional || positions.length !== 1)
      throw new CliError(
        "INVALID_ARGUMENT",
        "Unexpected positional arguments; use schema fields as --flags.",
      );
    const field = ["id", "query", "name"].find((field) => field in properties);
    if (!field || args[field] !== undefined)
      throw new CliError(
        "INVALID_ARGUMENT",
        "Use an explicit schema field flag for this command.",
      );
    args[field] = convert(positions[0], properties[field], field);
  }
  if (
    positional &&
    "limit" in properties &&
    /^list_|^search_/.test(tool.name)
  ) {
    const definition = properties.limit;
    const minimum =
      typeof definition.minimum === "number" ? definition.minimum : 1;
    const maximum =
      typeof definition.maximum === "number" ? definition.maximum : 250;
    args.limit ??=
      typeof definition.default === "number"
        ? definition.default
        : Math.max(minimum, Math.min(50, maximum));
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < minimum ||
      args.limit > maximum
    )
      throw new CliError(
        "INVALID_LIMIT",
        `List limit must be an integer from ${minimum} to ${maximum}. Use cursor to request another page.`,
      );
  }
  const dialect = String(tool.inputSchema.$schema || "");
  const validator = dialect.includes("2020-12")
    ? ajv2020
    : dialect.includes("2019-09")
      ? ajv2019
      : ajv;
  const validate = validator.compile(tool.inputSchema);
  if (!validate(args))
    throw new CliError(
      "INVALID_ARGUMENT",
      `Arguments do not match ${tool.name}'s input schema.`,
      validate.errors,
    );
  return { args, dryRun };
}
const singulars: Record<string, string> = {
  issues: "issue",
  projects: "project",
  teams: "team",
  users: "user",
  comments: "comment",
  documents: "document",
  cycles: "cycle",
  labels: "issue_label",
  statuses: "issue_status",
  initiatives: "initiative",
  milestones: "project_milestone",
  "project-updates": "project_update",
  "initiative-updates": "initiative_update",
  attachments: "attachment",
  "project-labels": "project_label",
};
export const nouns = Object.keys(singulars);
export function resolveTool(tools: Tool[], noun: string, verb: string): Tool {
  const singular = singulars[noun];
  const plural = singular.endsWith("status")
    ? singular + "es"
    : singular.endsWith("y")
      ? singular.slice(0, -1) + "ies"
      : singular + "s";
  const operation = verb === "resolve" ? "get" : verb;
  const base = noun.endsWith("ies")
    ? noun.slice(0, -3) + "y"
    : noun.endsWith("s")
      ? noun.slice(0, -1)
      : noun;
  const candidates =
    operation === "list"
      ? [
          `list_${plural}`,
          `list_${singular}`,
          `list_${noun.replaceAll("-", "_")}`,
        ]
      : [
          `${operation}_${singular}`,
          `${operation}_${plural}`,
          `${operation}_${base.replaceAll("-", "_")}`,
          ...(["create", "update"].includes(operation)
            ? [`save_${singular}`]
            : []),
        ];
  const tool = candidates
    .map((name) => tools.find((tool) => tool.name === name))
    .find(Boolean);
  if (!tool)
    throw new CliError(
      "UNSUPPORTED_COMMAND",
      `Linear does not currently expose ${noun} ${verb}. Run linear tools list to see available tools.`,
    );
  return tool;
}
