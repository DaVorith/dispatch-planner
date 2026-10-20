// Owner-only: who can sign in to this company's board.

import { useEffect, useState } from "react";
import { api, type Me } from "./api";

type User = Me["user"];

export function Team({ me }: { me: Me }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const load = () => api<{ users: User[] }>("/api/users").then((r) => setUsers(r.users)).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/users", { method: "POST", body: form });
      setAdded(form.email);
      setForm({ name: "", email: "", password: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="team">
      <h2>{me.company.name} team</h2>
      <table className="team-table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
        <tbody>
          {(users ?? []).map((u) => (
            <tr key={u.id}><td>{u.name}{u.id === me.user.id ? " (you)" : ""}</td><td>{u.email}</td>
              <td>{u.role === "owner" ? "Owner" : "Dispatcher"}</td></tr>
          ))}
        </tbody>
      </table>

      <form className="rules-panel" onSubmit={submit}>
        <fieldset>
          <legend>Add a dispatcher</legend>
          <label>Name<input type="text" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Email<input type="text" inputMode="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label>Temporary password
            <input type="text" required minLength={10} value={form.password} autoComplete="off"
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
        </fieldset>
        {error && <p className="warn small" role="alert">{error}</p>}
        {added && !error && <p className="small">Added {added}. Share the password with them directly, not by email.</p>}
        <div className="rules-actions"><button type="submit" className="btn btn-primary" disabled={busy}>Add dispatcher</button></div>
      </form>
    </div>
  );
}
