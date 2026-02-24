import { kv } from "@vercel/kv"

type Tier = "medium" | "large" | "unknown"

const EMPLOYEE_LARGE_THRESHOLD = 4000
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30
const ENRICH_TIMEOUT_MS = 1500

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "yandex.com",
  "zoho.com",
  "gmx.com",
  "mail.com",
])

function getDomainFromEmail(email: string): string | null {
  const at = email.lastIndexOf("@")
  if (at < 0) return null
  const domain = email.slice(at + 1).trim().toLowerCase()
  if (!domain || domain.includes(" ")) return null
  return domain
}

function tierFromEmployees(employees?: number): Tier {
  if (typeof employees !== "number") return "unknown"
  return employees >= EMPLOYEE_LARGE_THRESHOLD ? "large" : "medium"
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms)
    p.then((v) => {
      clearTimeout(t)
      resolve(v)
    }).catch((e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}

async function apolloOrgEnrich(
  domain: string
): Promise<{ employees?: number; apolloLatencyMs: number } | null> {
  const apiKey = process.env.APOLLO_API_KEY
  if (!apiKey) return null

  const start = Date.now()

  const resp = await fetch(
    `https://api.apollo.io/api/v1/organizations/enrich?domain=${encodeURIComponent(
      domain
    )}`,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
    }
  )

  const apolloLatencyMs = Date.now() - start

  if (!resp.ok) {
    console.error("Apollo failed:", resp.status)
    return null
  }

  const data: any = await resp.json()

  const employees =
    data?.organization?.estimated_num_employees ??
    data?.organization?.num_employees ??
    data?.organization?.employee_count ??
    data?.estimated_num_employees ??
    data?.num_employees ??
    data?.employee_count

  return {
    employees: typeof employees === "number" ? employees : undefined,
    apolloLatencyMs,
  }
}

export default async function handler(req: any, res: any) {
  const requestStart = Date.now()

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" })
    return
  }

  const email = String(req.body?.email ?? "").trim().toLowerCase()
  const domain = getDomainFromEmail(email)

  if (!domain) {
    res.status(400).json({
      tier: "unknown",
      domain: null,
      source: "bad_email",
      decision: "fallback_error",
      error: "bad_email",
      totalLatencyMs: Date.now() - requestStart,
    })
    return
  }

  if (FREE_EMAIL_DOMAINS.has(domain)) {
    res.status(200).json({
      tier: "unknown",
      domain,
      source: "free_email",
      decision: "fallback_error",
      error: "free_email",
      totalLatencyMs: Date.now() - requestStart,
    })
    return
  }

  const cacheKey = `seg:domain:${domain}`

  const cached = await kv.get<any>(cacheKey)
  if (cached?.tier) {
    res.status(200).json({
      tier: cached.tier as Tier,
      domain,
      employees: cached.employees,
      source: "kv",
      decision: "enriched",
      totalLatencyMs: Date.now() - requestStart,
    })
    return
  }

  try {
    const enriched = await withTimeout(apolloOrgEnrich(domain), ENRICH_TIMEOUT_MS)

    // If Apollo key missing or Apollo returned null, treat as "error fallback"
    if (!enriched) {
      res.status(200).json({
        tier: "unknown",
        domain,
        source: "apollo_null",
        decision: "fallback_error",
        error: "apollo_null",
        timeoutMs: ENRICH_TIMEOUT_MS,
        totalLatencyMs: Date.now() - requestStart,
      })
      return
    }

    const employees = enriched.employees
    const apolloLatencyMs = enriched.apolloLatencyMs

    const tier = tierFromEmployees(employees)

    await kv.set(
      cacheKey,
      { tier, employees, updatedAt: new Date().toISOString() },
      { ex: CACHE_TTL_SECONDS }
    )

    res.status(200).json({
      tier,
      domain,
      employees,
      source: "apollo",
      decision: "enriched",
      apolloLatencyMs,
      totalLatencyMs: Date.now() - requestStart,
    })
  } catch (e: any) {
    const msg = String(e?.message ?? "")
    const isTimeout = msg.toLowerCase().includes("timeout")

    res.status(200).json({
      tier: "unknown",
      domain,
      source: "timeout_or_error",
      decision: isTimeout ? "fallback_timeout" : "fallback_error",
      error: isTimeout ? "timeout" : "error",
      timeoutMs: ENRICH_TIMEOUT_MS,
      totalLatencyMs: Date.now() - requestStart,
    })
  }
}