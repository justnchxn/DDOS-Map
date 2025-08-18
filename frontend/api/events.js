export const config = { runtime: "edge" };

const RADAR_URL =
  "https://api.cloudflare.com/client/v4/radar/attacks/layer3/top/locations/origin?dateRange=1d&limit=20";

function mapRadarItem(it) {
  const code = it?.originCountryAlpha2 || it?.countryAlpha2 || "US";
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
      return [];
    }
    const r = await fetch(RADAR_URL, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) {
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
  let items = await fetchRadarOnce();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const push = (s) => controller.enqueue(encoder.encode(s));

      push(`: connected ${Date.now()}\n\n`);

      const hb = setInterval(() => {
        push(`: ping ${Date.now()}\n\n`);
      }, 15000);

      const refresh = setInterval(async () => {
        const fresh = await fetchRadarOnce();
        if (fresh.length) items = fresh;
      }, 60000);

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
