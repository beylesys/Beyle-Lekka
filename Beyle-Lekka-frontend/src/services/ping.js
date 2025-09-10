export async function ping() {
  const r = await fetch('/health'); // goes to backend via the proxy
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}
