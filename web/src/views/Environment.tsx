import type { ReactNode } from "react";
import { Camera, CameraOff, Home, Lightbulb, LightbulbOff, Lock, LockOpen, RotateCcw, ShieldCheck, ShieldOff, ShoppingCart, Thermometer, Workflow } from "lucide-react";
import { useSentry } from "../state";
import { Badge, Button, Card, Empty, Spinner, Switch } from "../components/ui";
import { clock, timeAgo, titleCase } from "../lib/format";

export function Environment() {
  const s = useSentry();
  const h = s.household;
  if (!h) return <Spinner label="Loading simulated household over MCP…" />;

  const Fault = ({ id }: { id: string }) =>
    h.faultableDevices.includes(id) ? (
      <label className="fault" title="Simulate this device being offline to see failures and partial execution">
        {h.faults[id] ? "offline" : "online"}
        <Switch checked={!!h.faults[id]} onChange={(v) => void s.setFault(id, v)} label={`Simulate ${titleCase(id)} offline`} disabled={s.busy[`fault:${id}`]} />
      </label>
    ) : null;

  const Device = ({ id, icon, tone, name, state, extra }: { id: string; icon: ReactNode; tone: string; name: string; state: ReactNode; extra?: ReactNode }) => (
    <div className="device">
      <div className={`device-icon ${tone}`}>{icon}</div>
      <div className="device-grow">
        <div className="device-name">{name}</div>
        <div className="device-state">{state}</div>
      </div>
      {extra}
      <Fault id={id} />
    </div>
  );

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="sim-banner">
        <Home size={16} />
        <span>
          Simulated household. State is persisted by the SentryFlow server and changes only through executed actions. No real Alexa, Ring or other device is connected.
        </span>
        <span style={{ flex: 1 }} />
        <span className="hint">updated {timeAgo(h.updatedAt)}</span>
      </div>

      <div className="grid-3">
        <Card title="Lights">
          {Object.entries(h.lights).map(([id, l]) => (
            <Device
              key={id}
              id={id}
              icon={l.on ? <Lightbulb size={16} /> : <LightbulbOff size={16} />}
              tone={l.on ? "on" : ""}
              name={titleCase(id)}
              state={l.on ? `On · ${l.brightness}%` : "Off"}
              extra={
                <div className="bar" aria-hidden>
                  <span style={{ width: `${l.on ? l.brightness : 0}%` }} />
                </div>
              }
            />
          ))}
        </Card>

        <Card title="Climate">
          <div className="row between" style={{ marginBottom: 6 }}>
            <div>
              <div className="big-temp">{h.thermostat.targetC.toFixed(1)}°C</div>
              <div className="hint">target · currently {h.thermostat.currentC.toFixed(1)}°C</div>
            </div>
            <Badge tone={h.thermostat.mode === "off" ? "deny" : h.thermostat.mode === "eco" ? "allow" : "neutral"}>{h.thermostat.mode}</Badge>
          </div>
          <Device id="thermostat" icon={<Thermometer size={16} />} tone="" name="Thermostat" state={`Mode ${h.thermostat.mode}`} />
        </Card>

        <Card title="Security">
          <Device
            id="security"
            icon={h.security.mode === "disarmed" ? <ShieldOff size={16} /> : <ShieldCheck size={16} />}
            tone={h.security.mode === "disarmed" ? "" : "ok"}
            name="Alarm system"
            state={`${titleCase(h.security.mode)} · since ${clock(h.security.changedAt)}`}
          />
          {Object.entries(h.locks).map(([id, l]) => (
            <Device key={id} id={id} icon={l.locked ? <Lock size={16} /> : <LockOpen size={16} />} tone={l.locked ? "ok" : "bad"} name={titleCase(id)} state={l.locked ? "Locked" : "Unlocked"} />
          ))}
          {Object.entries(h.cameras).map(([id, c]) => (
            <Device key={id} id={id} icon={c.recording ? <Camera size={16} /> : <CameraOff size={16} />} tone={c.recording ? "ok" : "bad"} name={titleCase(id.replace("_cam", " camera"))} state={c.recording ? "Recording" : "Not recording"} />
          ))}
        </Card>

        <Card title="Routines">
          {Object.entries(h.routines).map(([id, r]) => (
            <div key={id} className="device">
              <div className={`device-icon ${r.enabled ? "on" : ""}`}>
                <Workflow size={16} />
              </div>
              <div className="device-grow">
                <div className="device-name">{r.name}</div>
                <div className="device-state">{r.description}</div>
              </div>
              <Badge tone={r.enabled ? "allow" : "muted"}>{r.enabled ? `on · ${clock(r.enabledAt)}` : "off"}</Badge>
            </div>
          ))}
        </Card>

        <Card title="Simulated orders" subtitle="No payment details exist anywhere in this system">
          {h.orders.length === 0 ? (
            <Empty icon={<ShoppingCart size={22} />} title="No orders" />
          ) : (
            h.orders.map((o) => (
              <div key={o.orderId} className="device">
                <div className="device-icon on">
                  <ShoppingCart size={16} />
                </div>
                <div className="device-grow">
                  <div className="device-name">
                    {o.quantity} × {o.name}
                  </div>
                  <div className="device-state">
                    ${o.totalUsd.toFixed(2)} · {clock(o.placedAt)} · <code>{o.orderId}</code>
                  </div>
                </div>
                <Badge tone="muted">simulated</Badge>
              </div>
            ))
          )}
        </Card>

        <Card title="Simulation controls" subtitle="Operator actions, sent over the approver MCP session and audited">
          <div className="stack">
            <p className="hint">Resetting restores the initial device state. The append-only audit log is never cleared.</p>
            <div className="row">
              <Button icon={<RotateCcw size={15} />} onClick={() => void s.resetEnvironment(false)} loading={s.busy.reset}>
                Reset devices
              </Button>
              <Button variant="danger" icon={<RotateCcw size={15} />} onClick={() => window.confirm("Reset devices and delete all plans? The audit log is kept.") && void s.resetEnvironment(true)} loading={s.busy.reset}>
                Reset devices & plans
              </Button>
            </div>
            {Object.keys(h.faults).length > 0 && (
              <div className="callout red">
                <CameraOff size={15} />
                <span>Offline (simulated): {Object.keys(h.faults).map(titleCase).join(", ")}</span>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
