import { PRODUCT_CATALOG, validateToolArgs, type ProductSku, type ToolName } from "../domain/catalog.js";
import { SentryError } from "../domain/types.js";

/** Entire simulated household. Nothing here talks to a real device. */
export interface HouseholdState {
  simulated: true;
  lights: Record<string, { on: boolean; brightness: number }>;
  thermostat: { mode: string; targetC: number; currentC: number };
  locks: Record<string, { locked: boolean }>;
  security: { mode: string; changedAt: string };
  cameras: Record<string, { recording: boolean }>;
  routines: Record<string, { name: string; description: string; enabled: boolean; enabledAt?: string }>;
  orders: { orderId: string; sku: string; name: string; quantity: number; totalUsd: number; placedAt: string; simulated: true }[];
  /** Simulated device faults, used to demonstrate tool failures and partial execution. */
  faults: Record<string, "offline">;
  updatedAt: string;
}

export function initialHousehold(now: Date): HouseholdState {
  const at = now.toISOString();
  return {
    simulated: true,
    lights: {
      living_room: { on: true, brightness: 80 },
      kitchen: { on: true, brightness: 100 },
      bedroom: { on: false, brightness: 40 },
      porch: { on: true, brightness: 60 },
    },
    thermostat: { mode: "heat", targetC: 21.5, currentC: 21 },
    locks: { front_door: { locked: true }, back_door: { locked: false } },
    security: { mode: "disarmed", changedAt: at },
    cameras: { front_door_cam: { recording: true }, backyard_cam: { recording: true } },
    routines: {
      leaving_home: { name: "Leaving Home", description: "Vacancy lighting schedule and auto-lock after 5 minutes.", enabled: false },
      good_night: { name: "Good Night", description: "Dim interior lights at 23:00 and lower heat 2 °C.", enabled: false },
      vacation_mode: { name: "Vacation Mode", description: "Randomised lights, mail-hold reminder, heating to eco for 14 days.", enabled: false },
    },
    orders: [],
    faults: {},
    updatedAt: at,
  };
}

/** Hard physical limits enforced by the "device" itself, independent of policy (defense in depth). */
const THERMOSTAT_HARD_MIN = 10;
const THERMOSTAT_HARD_MAX = 32;

export interface ExecutionOutcome {
  result: Record<string, unknown>;
}

function assertOnline(state: HouseholdState, deviceId: string) {
  if (state.faults[deviceId] === "offline") throw new SentryError("TOOL_FAILURE", `Simulated device ${deviceId} is offline`);
}

/**
 * Applies a tool to the household state IN PLACE and returns a structured result.
 * Callers must hold the store lock and must have passed policy + approval checks; this function
 * only re-validates arguments and physical limits.
 */
export function executeTool(state: HouseholdState, tool: ToolName, rawArgs: Record<string, unknown>, now: Date, id: () => string): ExecutionOutcome {
  const v = validateToolArgs(tool, rawArgs);
  if (!v.ok) throw new SentryError("INVALID_ARGUMENT", v.errors.join("; "));
  const args = v.args;
  const at = now.toISOString();
  const touch = () => {
    state.updatedAt = at;
  };

  switch (tool) {
    case "get_device_state":
      return { result: { snapshot: structuredClone(state) } };
    case "get_security_status":
      return { result: { security: { ...state.security }, locks: structuredClone(state.locks), cameras: structuredClone(state.cameras) } };
    case "set_light": {
      const ids = args.lightId === "all" ? Object.keys(state.lights) : [String(args.lightId)];
      for (const lid of ids) assertOnline(state, lid);
      const changed: Record<string, unknown> = {};
      for (const lid of ids) {
        const light = state.lights[lid]!;
        const before = { ...light };
        light.on = Boolean(args.on);
        if (typeof args.brightness === "number") light.brightness = args.brightness;
        changed[lid] = { before, after: { ...light } };
      }
      touch();
      return { result: { changed } };
    }
    case "set_thermostat": {
      assertOnline(state, "thermostat");
      const target = args.targetC as number | undefined;
      if (target !== undefined && (target < THERMOSTAT_HARD_MIN || target > THERMOSTAT_HARD_MAX))
        throw new SentryError("TOOL_FAILURE", `Thermostat hardware rejects ${target} °C (limits ${THERMOSTAT_HARD_MIN}–${THERMOSTAT_HARD_MAX})`);
      const before = { ...state.thermostat };
      state.thermostat.mode = String(args.mode);
      if (target !== undefined) state.thermostat.targetC = target;
      touch();
      return { result: { before, after: { ...state.thermostat } } };
    }
    case "lock_door":
    case "unlock_door": {
      const doorId = String(args.doorId);
      assertOnline(state, doorId);
      const before = { ...state.locks[doorId]! };
      state.locks[doorId] = { locked: tool === "lock_door" };
      touch();
      return { result: { doorId, before, after: { ...state.locks[doorId] } } };
    }
    case "set_security_mode": {
      assertOnline(state, "security");
      const before = { ...state.security };
      state.security = { mode: String(args.mode), changedAt: at };
      touch();
      return { result: { before, after: { ...state.security } } };
    }
    case "set_camera_recording": {
      const cameraId = String(args.cameraId);
      assertOnline(state, cameraId);
      const before = { ...state.cameras[cameraId]! };
      state.cameras[cameraId] = { recording: Boolean(args.recording) };
      touch();
      return { result: { cameraId, before, after: { ...state.cameras[cameraId] } } };
    }
    case "enable_routine": {
      const r = state.routines[String(args.routineId)]!;
      const before = { enabled: r.enabled };
      r.enabled = true;
      r.enabledAt = at;
      touch();
      return { result: { routineId: args.routineId, name: r.name, before, after: { enabled: true, enabledAt: at } } };
    }
    case "purchase_item": {
      const sku = args.sku as ProductSku;
      const product = PRODUCT_CATALOG[sku];
      const quantity = args.quantity as number;
      const order = {
        orderId: `sim_order_${id()}`,
        sku,
        name: product.name,
        quantity,
        totalUsd: Math.round(product.unitPriceUsd * quantity * 100) / 100,
        placedAt: at,
        simulated: true as const,
      };
      state.orders.push(order);
      touch();
      return { result: { order, note: "Simulated order. No payment was made and nothing will ship." } };
    }
  }
}

/** Devices that can be marked offline from the environment view. */
export function faultableDevices(state: HouseholdState): string[] {
  return [...Object.keys(state.lights), "thermostat", ...Object.keys(state.locks), "security", ...Object.keys(state.cameras)];
}
