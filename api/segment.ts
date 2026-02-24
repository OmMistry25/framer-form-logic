import type { VercelRequest, VercelResponse } from "@vercel/node";
import { kv } from "@vercel/kv";

type Tier = "medium" | "large" | "unknown";

const EMPLOYEE_LARGE_THRESHOLD = 500; // change if needed
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com","googlemail.com","yahoo.com","hotmail.com","outlook.com","live.com","msn.com",
  "icloud.com","me.com","mac.com","aol.com","proton.me","protonmail.com","yandex.com",
  "zoho.com","gmx.com","mail.com"
]);

function getDomainFromEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || domain.includes(" ")) return null;
  return domain;
}

function tierFromEmployees(employees?: number): Tier {
  if (typeof employees !== "number") return "unknown";
  return employees >= EMPLOYEE_LARGE_THRESHOLD ? "large" : "medium";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
     .catch((e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Apollo Organization Enrichment:
 * GET https://api.apollo.io/api/v1/organizations/enrich?domain=...
 * Auth: x-api-key header
 */
async function apolloOrgEnrich(domain: string): Promise<{ employees?: number } | null> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  const url = `https://api.apollo.io/api/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "accept": "application/json",
      "cache-control": "no-cache",
      "content-type": "application/json",
      "x-api-key": apiKey
    }
  });

  if (!resp.ok) return null;

  const data: any = await resp.json();

  // Apollo response shapes can vary; handle common patterns safely.
  // We try a few likely fields:
  const employees =
    data?.organization?.estimated_num_employees ??
    data?.organization?.num_employees ??
    data?.organization?.employee_count ??
    data?.estimated_num_employees ??
    data?.num_employees ??
    data?.employee_count;

  return {
    employees: typeof employees === "number" ? employees : undefined
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const domain = getDomainFromEmail(email);

  if (!domain) {
    res.status(400).json({ tier: "unknown", reason: "bad_email" });
    return;
  }

  if (FREE_EMAIL_DOMAINS.has(domain)) {
    res.status(200).json({ tier: "unknown", domain, reason: "free_email" });
    return;
  }

  const cacheKey = `seg:domain:${domain}`;

  // 1) KV fast path
  const cached = await kv.get<{ tier: Tier; employees?: number; updatedAt?: string }>(cacheKey);
  if (cached?.tier) {
    res.status(200).json({
      tier: cached.tier,
      domain,
      employees: cached.employees,
      updatedAt: cached.updatedAt,
      source: "kv"
    });
    return;
  }

  // 2) Apollo best-effort. Keep it short to respect the client’s 300ms budget.
  // We target <= 250ms server-side so the client can still open within 300ms.
  try {
    const enriched = await withTimeout(apolloOrgEnrich(domain), 250);
    const employees = enriched?.employees;
    const tier = tierFromEmployees(employees);

    // Cache even unknown to avoid hammering Apollo for junk domains (shorter TTL for unknown)
    const ttl = tier === "unknown" ? 60 * 60 * 24 * 3 : CACHE_TTL_SECONDS; // 3 days for unknown
    await kv.set(cacheKey, { tier, employees, updatedAt: new Date().toISOString() }, { ex: ttl });

    res.status(200).json({ tier, domain, employees, source: "apollo" });
    return;
  } catch {
    // If Apollo is slow or fails, return unknown quickly. Client will default mid-market.
    res.status(200).json({ tier: "unknown", domain, source: "timeout_or_error" });
    return;
  }
}