import { useState } from "react";
import { api, type Me } from "./api";

export function Login({ onSignedIn, allowSignup = true }: { onSignedIn: () => void; allowSignup?: boolean }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [form, setForm] = useState({ companyName: "", name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "in") await api<Me>("/api/auth/login", { method: "POST", body: { email: form.email, password: form.password } });
      else await api<Me>("/api/auth/signup", { method: "POST", body: form });
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>Route Planner</h1>
        <p className="dim">{mode === "in" ? "Sign in to your company's board." : "Create an account for your company."}</p>
        {mode === "up" && (
          <>
            <label>Company name<input required maxLength={120} value={form.companyName} onChange={set("companyName")} autoComplete="organization" /></label>
            <label>Your name<input required maxLength={80} value={form.name} onChange={set("name")} autoComplete="name" /></label>
          </>
        )}
        <label>Email<input required type="email" value={form.email} onChange={set("email")} autoComplete="email" /></label>
        <label>Password
          <input required type="password" minLength={mode === "up" ? 10 : undefined} value={form.password} onChange={set("password")}
            autoComplete={mode === "in" ? "current-password" : "new-password"} />
          {mode === "up" && <small className="dim">At least 10 characters.</small>}
        </label>
        {error && <p className="warn small" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{mode === "in" ? "Sign in" : "Create account"}</button>
        {allowSignup && (
          <p className="small dim">
            {mode === "in" ? "New here? " : "Already have an account? "}
            <button type="button" className="link" onClick={() => { setMode(mode === "in" ? "up" : "in"); setError(null); }}>
              {mode === "in" ? "Create an account" : "Sign in"}
            </button>
          </p>
        )}
      </form>
    </div>
  );
}
