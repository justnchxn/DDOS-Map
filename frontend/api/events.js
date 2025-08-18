// frontend/api/events.js
export const config = { runtime: "edge" };

const RADAR_URL =
  "https://api.cloudflare.com/client/v4/radar/attacks/layer3/top/locations/origin?dateRange=1d&limit=20";

// Map a Radar item -> your frontend schema
function mapRadarItem(it) {
  // Cloudflare returns e.g. { originCountryAlpha2, originCountryName, value, rank }
  const code = it?.originCountryAlpha2 || it?.countryAlpha2 || "US";
  // "value" is a percentage / index-like figure; convert to a reasonable width/intensity
  const intensity = Math.max(1, Math.min(5, Math.round(Number(it?.value || 1))));
  return {
    src_country: String(code).toUpperCase(),
    dst_country: "GLOBAL",
    intensity_index: intensity,
    attack_type: "Layer 3/4"
  };
}

async function fetchRadarOnce() {
  try {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) {
      // No token? Return empty, caller will fall back to synthetic events
      return [];
    }
    const r = await fetch(RADAR_URL, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) {
      // Soft-fail (don’t throw) so the stream stays alive
      return [];
    }
    const j = await r.json();
    const list = j?.result?.top_0 || [];
    return list.map(mapRadarItem);
  } catch {
    return [];
  }
}

export default async function handler(req) {
  // Pull initial list
  let items = await fetchRadarOnce();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const push = (s) => controller.enqueue(encoder.encode(s));

      // Tell EventSource we’re up
      push(`: connected ${Date.now()}\n\n`);

      // Heartbeat to keep proxies from idling the stream
      const hb = setInterval(() => {
        push(`: ping ${Date.now()}\n\n`);
      }, 15000);

      // Refresh Radar data every 60s (non-blocking)
      const refresh = setInterval(async () => {
        const fresh = await fetchRadarOnce();
        if (fresh.length) items = fresh;
      }, 60000);

      // Emit one event ~every 800ms (sample from latest list or synthesize)
      const tick = setInterval(() => {
        const evt =
          items.length > 0
            ? items[Math.floor(Math.random() * items.length)]
            : {
                src_country: ["US", "GB", "DE", "FR", "BR", "IN", "JP", "HK"][
                  Math.floor(Math.random() * 8)
                ],
                dst_country: "GLOBAL",
                intensity_index: Math.ceil(Math.random() * 5),
                attack_type: "Layer 3/4"
              };

        const payload = { ts: Date.now(), ...evt };
        push(`data: ${JSON.stringify(payload)}\n\n`);
      }, 800);

      // Clean up on client disconnect
      const close = () => {
        clearInterval(hb);
        clearInterval(refresh);
        clearInterval(tick);
        try { controller.close(); } catch {}
      };
      req?.signal?.addEventListener("abort", close);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
