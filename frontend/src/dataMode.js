import axios from "axios"
import { API } from "./api"
import { fabricated, fakeGet, fakePost } from "./fakeData"

// ─────────────────────────────────────────────────────────────
// DATA MODE: "real" talks to the backend, "demo" answers every request from fabricated data (fakeData.js).
// The switch is one axios interceptor, so every tab and every panel follows it with no changes of its own.
// The choice is remembered. Switching reloads the page, so nothing from the other mode is left on screen.
// ─────────────────────────────────────────────────────────────
const KEY = "pz.dataMode"

export const getDataMode = () => { try { return localStorage.getItem(KEY) === "demo" ? "demo" : "real" } catch { return "real" } }
export function setDataMode(mode) {
  try { localStorage.setItem(KEY, mode === "demo" ? "demo" : "real") } catch { /* storage unavailable */ }
  window.location.reload()
}

const answer = (config) => {
  const path = String(config.url || "").replace(API, "").split("?")[0]
  const method = String(config.method || "get").toLowerCase()
  let body = null
  if (method === "get") body = fakeGet(path, config.params || {})
  else { let sent = {}; try { sent = typeof config.data === "string" ? JSON.parse(config.data) : (config.data || {}) } catch { /* not json */ } body = fakePost(path, sent) }
  const ok = body !== null
  const response = { data: ok ? body : { error: "Not available in demo data" }, status: ok ? 200 : 404, statusText: ok ? "OK" : "Not Found", headers: {}, config, request: {} }
  return ok ? Promise.resolve(response) : Promise.reject(Object.assign(new Error("Not available in demo data"), { response, config, isAxiosError: true }))
}

// Luffy's chat and event explanations only need text in, text out, so they use the real AI even in demo mode
const REAL_AI = ["/chat", "/analyze-event"]

axios.interceptors.request.use((config) => {
  const path = String(config.url || "").replace(API, "").split("?")[0]
  if (getDataMode() === "demo" && String(config.url || "").startsWith(API) && !REAL_AI.includes(path)) config.adapter = answer
  if (getDataMode() === "demo" && path === "/analyze-event") {
    // the demo event is not in the database, so send it along
    let sent = {}; try { sent = typeof config.data === "string" ? JSON.parse(config.data) : (config.data || {}) } catch { /* not json */ }
    const ev = fabricated().events.find(e => e.id === Number(sent.event_id))
    if (ev) { const { _fi, ...plain } = ev; config.data = JSON.stringify({ ...sent, event: plain }) }
  }
  return config
})
