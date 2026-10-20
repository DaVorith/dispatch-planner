import { useState } from "react";
import { HOUR } from "../engine/clock";
import { CITIES } from "../engine/synthetic";
import type { Equipment, Truck } from "../engine/types";
import { hourLabel } from "./format";

const cityKey = (c: { city: string; state: string }) => `${c.city}|${c.state}`;
const findCity = (key: string) => CITIES.find((c) => cityKey(c) === key) ?? null;

export function RulesPanel({ truck, isNew = false, onSave, onRemove, onCancel }: {
  truck: Truck; isNew?: boolean; onSave: (t: Truck) => Promise<void>; onRemove?: () => Promise<void>; onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Truck>(truck);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const attempt = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Couldn't save"); setBusy(false); }
  };
  const [availableIn, setAvailableIn] = useState(() => Math.max(0, Math.round((truck.availableAt - Date.now()) / HOUR)));
  const r = draft.rules;
  const set = (patch: Partial<Truck>) => setDraft((d) => ({ ...d, ...patch }));
  const setRule = (patch: Partial<Truck["rules"]>) => setDraft((d) => ({ ...d, rules: { ...d.rules, ...patch } }));
  const num = (v: string, fallback = 0) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : fallback);

  return (
    <form className="rules-panel" onSubmit={(e) => {
      e.preventDefault();
      void attempt(() => onSave({ ...draft, name: draft.name.trim() || truck.name, availableAt: Date.now() + availableIn * HOUR }));
    }}>
      <fieldset>
        <legend>Truck</legend>
        <label>Name or unit number
          <input id="f-name" type="text" required maxLength={60} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>Driver
          <input id="f-driver" type="text" maxLength={80} value={draft.driver} onChange={(e) => set({ driver: e.target.value })} />
        </label>
        <label>Empty at
          <select id="f-location" value={cityKey(draft.location)} onChange={(e) => set({ location: findCity(e.target.value) ?? draft.location })}>
            {CITIES.map((c) => <option key={cityKey(c)} value={cityKey(c)}>{c.city}, {c.state}</option>)}
          </select>
        </label>
        <label>Available in (hours)
          <input id="f-available" type="number" min={0} max={168} value={availableIn} onChange={(e) => setAvailableIn(num(e.target.value))} />
        </label>
        <label>Equipment
          <select id="f-equipment" value={draft.equipment} onChange={(e) => set({ equipment: e.target.value as Equipment })}>
            <option value="van">Dry van</option>
            <option value="reefer">Reefer</option>
            <option value="flatbed">Flatbed</option>
          </select>
        </label>
        <label>Max weight (lb)
          <input id="f-weight" type="number" step={500} min={10000} max={48000} value={draft.maxWeightLbs} onChange={(e) => set({ maxWeightLbs: num(e.target.value, 45000) })} />
        </label>
      </fieldset>

      <fieldset>
        <legend>Which loads to consider</legend>
        <label>Max deadhead to a pickup (mi)
          <input id="f-deadhead" type="number" min={0} max={500} step={10} value={r.maxDeadheadMiles} onChange={(e) => setRule({ maxDeadheadMiles: num(e.target.value) })} />
        </label>
        <label>Minimum loaded RPM ($/mi, 0 = any)
          <input id="f-minrpm" type="number" min={0} max={10} step={0.05} value={r.minLoadedRpm} onChange={(e) => setRule({ minLoadedRpm: num(e.target.value) })} />
        </label>
        <label>Avoid states (comma separated)
          <input id="f-avoid" type="text" value={r.avoidStates.join(", ")} placeholder="e.g. CA, NY"
            onChange={(e) => setRule({ avoidStates: e.target.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) })} />
        </label>
        <label className="check">
          <input id="f-rated" type="checkbox" checked={r.excludeLoadsWithoutRate} onChange={(e) => setRule({ excludeLoadsWithoutRate: e.target.checked })} />
          Skip loads with no posted rate
        </label>
      </fieldset>

      <fieldset>
        <legend>How to build plans</legend>
        <label>Loads per plan
          <select id="f-legs" value={r.maxLoadsPerRoute} onChange={(e) => setRule({ maxLoadsPerRoute: num(e.target.value, 3) })}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>Hours at each pickup / delivery
          <input id="f-dwell" type="number" min={0} max={8} step={0.5} value={r.dwellHours} onChange={(e) => setRule({ dwellHours: num(e.target.value, 2) })} />
        </label>
        <label>No same-day reload if delivery ends after
          <select id="f-cutoff" value={r.noSameDayPickupAfterHour ?? "off"}
            onChange={(e) => setRule({ noSameDayPickupAfterHour: e.target.value === "off" ? null : num(e.target.value, 12) })}>
            <option value="off">Off</option>
            {[10, 11, 12, 13, 14, 15, 16, 17, 18].map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </label>
        <label>Average speed (mph)
          <input id="f-speed" type="number" min={30} max={65} value={r.avgSpeedMph} onChange={(e) => setRule({ avgSpeedMph: num(e.target.value, 50) })} />
        </label>
        <label>Finish near
          <select id="f-home" value={r.homeBase ? cityKey(r.homeBase) : ""}
            onChange={(e) => {
              const home = findCity(e.target.value);
              setRule({ homeBase: home, maxMilesFromHomeAtEnd: home ? r.maxMilesFromHomeAtEnd ?? 250 : null });
            }}>
            <option value="">Anywhere</option>
            {CITIES.map((c) => <option key={cityKey(c)} value={cityKey(c)}>{c.city}, {c.state}</option>)}
          </select>
        </label>
        {r.homeBase && (
          <label>Within (mi)
            <input id="f-home-mi" type="number" min={25} max={1000} step={25} value={r.maxMilesFromHomeAtEnd ?? 250}
              onChange={(e) => setRule({ maxMilesFromHomeAtEnd: num(e.target.value, 250) })} />
          </label>
        )}
      </fieldset>

      {error && <p className="warn small" role="alert">{error}</p>}
      <div className="rules-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{isNew ? "Add truck" : "Save and rebuild plans"}</button>
        <button type="button" className="btn btn-quiet" onClick={onCancel} disabled={busy}>Cancel</button>
        {onRemove && (confirmRemove ? (
          <span className="confirm">
            Remove {truck.name}?{" "}
            <button type="button" className="link warn" disabled={busy} onClick={() => void attempt(onRemove)}>Remove</button>{" "}
            <button type="button" className="link" onClick={() => setConfirmRemove(false)}>Keep</button>
          </span>
        ) : (
          <button type="button" className="link remove" onClick={() => setConfirmRemove(true)}>Remove truck</button>
        ))}
      </div>
    </form>
  );
}
