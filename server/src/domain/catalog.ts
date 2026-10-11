import { z } from "zod";
import { hasDangerousKeys } from "./safety.js";

/**
 * The household tool catalog. These are the only operations the simulated environment can perform.
 * Argument schemas are strict and are the single source of truth for validation of model output,
 * MCP input, and executor input.
 */

export const LIGHT_IDS = ["living_room", "kitchen", "bedroom", "porch"] as const;
export const DOOR_IDS = ["front_door", "back_door"] as const;
export const CAMERA_IDS = ["front_door_cam", "backyard_cam"] as const;
export const ROUTINE_IDS = ["leaving_home", "good_night", "vacation_mode"] as const;
export const THERMOSTAT_MODES = ["heat", "cool", "auto", "eco", "off"] as const;
export const SECURITY_MODES = ["disarmed", "armed_home", "armed_away"] as const;

/** Simulated store. Prices are trusted server-side data; the model never supplies a price. */
export const PRODUCT_CATALOG = {
  coffee_beans: { name: "Coffee beans, 1 kg", unitPriceUsd: 18.5 },
  paper_towels: { name: "Paper towels, 6 rolls", unitPriceUsd: 12.99 },
  led_bulbs_4pk: { name: "LED bulbs, 4-pack", unitPriceUsd: 9.99 },
  air_filter: { name: "HVAC air filter", unitPriceUsd: 34.0 },
  smart_plug: { name: "Smart plug", unitPriceUsd: 24.99 },
  robot_vacuum: { name: "Robot vacuum", unitPriceUsd: 279.0 },
} as const;
export type ProductSku = keyof typeof PRODUCT_CATALOG;
export const PRODUCT_SKUS = Object.keys(PRODUCT_CATALOG) as [ProductSku, ...ProductSku[]];

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/** Categories let natural-language user constraints refer to groups of tools. */
export type ToolCategory = "read" | "lighting" | "climate" | "locks" | "unlock" | "security" | "routines" | "purchase";

interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  args: S;
  categories: ToolCategory[];
  readOnly: boolean;
  /** Returns the categories a specific invocation belongs to (e.g. disarming is "security"). */
  invocationCategories?: (args: Record<string, unknown>) => ToolCategory[];
}

const def = <S extends z.ZodTypeAny>(d: ToolDef<S>) => d;

export const TOOL_DEFS = {
  get_device_state: def({
    name: "get_device_state",
    description: "Read the current state of every simulated device.",
    args: z.object({}).strict(),
    categories: ["read"],
    readOnly: true,
  }),
  get_security_status: def({
    name: "get_security_status",
    description: "Read the simulated security system mode, door locks and camera recording state.",
    args: z.object({}).strict(),
    categories: ["read"],
    readOnly: true,
  }),
  set_light: def({
    name: "set_light",
    description: "Turn a simulated light (or all lights) on/off, optionally setting brightness 0–100.",
    args: z
      .object({
        lightId: z.enum([...LIGHT_IDS, "all"]),
        on: z.boolean(),
        brightness: z.number().int().min(0).max(100).optional(),
      })
      .strict(),
    categories: ["lighting"],
    readOnly: false,
  }),
  set_thermostat: def({
    name: "set_thermostat",
    description: "Set the simulated thermostat mode and optional target temperature in °C.",
    args: z
      .object({
        mode: z.enum(THERMOSTAT_MODES),
        targetC: z.number().min(-50).max(60).optional(),
      })
      .strict(),
    categories: ["climate"],
    readOnly: false,
  }),
  lock_door: def({
    name: "lock_door",
    description: "Lock a simulated door.",
    args: z.object({ doorId: z.enum(DOOR_IDS) }).strict(),
    categories: ["locks"],
    readOnly: false,
  }),
  unlock_door: def({
    name: "unlock_door",
    description: "Unlock a simulated door. Sensitive.",
    args: z.object({ doorId: z.enum(DOOR_IDS) }).strict(),
    categories: ["locks", "unlock"],
    readOnly: false,
  }),
  set_security_mode: def({
    name: "set_security_mode",
    description: "Arm or disarm the simulated security system.",
    args: z.object({ mode: z.enum(SECURITY_MODES) }).strict(),
    categories: ["security"],
    readOnly: false,
    invocationCategories: (a) => (a.mode === "disarmed" ? ["security"] : []),
  }),
  set_camera_recording: def({
    name: "set_camera_recording",
    description: "Start or stop recording on a simulated camera.",
    args: z.object({ cameraId: z.enum(CAMERA_IDS), recording: z.boolean() }).strict(),
    categories: ["security"],
    readOnly: false,
    invocationCategories: (a) => (a.recording ? [] : ["security"]),
  }),
  enable_routine: def({
    name: "enable_routine",
    description: "Enable a simulated household routine from the routine catalog.",
    args: z.object({ routineId: z.enum(ROUTINE_IDS) }).strict(),
    categories: ["routines"],
    readOnly: false,
  }),
  purchase_item: def({
    name: "purchase_item",
    description: "Place a SIMULATED order from the demo product catalog. No real purchase occurs.",
    args: z
      .object({
        sku: z.enum(PRODUCT_SKUS),
        quantity: z.number().int().min(1).max(10),
      })
      .strict(),
    categories: ["purchase"],
    readOnly: false,
  }),
} as const;

export type ToolName = keyof typeof TOOL_DEFS;
export const TOOL_NAMES = Object.keys(TOOL_DEFS) as [ToolName, ...ToolName[]];
export type ToolArgs<T extends ToolName> = z.infer<(typeof TOOL_DEFS)[T]["args"]>;

export function isToolName(name: unknown): name is ToolName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(TOOL_DEFS, name);
}

export type ArgValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errors: string[] };

/** Validates arguments for a tool. Unknown keys are rejected (strict) — never silently passed through. */
export function validateToolArgs(tool: string, args: unknown): ArgValidation {
  if (!isToolName(tool)) return { ok: false, errors: [`Unknown tool "${String(tool).slice(0, 64)}"`] };
  if (hasDangerousKeys(args)) return { ok: false, errors: ["Arguments contain a forbidden key (__proto__/constructor/prototype)"] };
  const parsed = TOOL_DEFS[tool].args.safeParse(args ?? {});
  if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

/** Categories that apply to one concrete invocation, used for user-constraint matching. */
export function categoriesFor(tool: ToolName, args: Record<string, unknown>): ToolCategory[] {
  const d: { categories: readonly ToolCategory[]; invocationCategories?: (a: Record<string, unknown>) => ToolCategory[] } = TOOL_DEFS[tool];
  // Tools whose sensitivity depends on arguments (arming vs disarming) decide per invocation.
  return d.invocationCategories ? d.invocationCategories(args) : [...d.categories];
}

/** Derived facts computed from trusted data, available to policy conditions. */
export function derivedFacts(tool: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  if (tool === "purchase_item") {
    const sku = args.sku as ProductSku;
    const qty = args.quantity as number;
    const product = PRODUCT_CATALOG[sku];
    return { unitPriceUsd: product.unitPriceUsd, totalUsd: Math.round(product.unitPriceUsd * qty * 100) / 100 };
  }
  return {};
}
