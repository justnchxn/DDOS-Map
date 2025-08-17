export default async function handler(req, res) {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (res.flushHeaders) res.flushHeaders();

  // Let the client mark the connection as open
  res.write(`: connected ${Date.now()}\n\n`);

  async function fetchCloudflareData() {
    try {
      const token = process.env.CLOUDFLARE_API_TOKEN;
      if (!token) {
        console.warn("CLOUDFLARE_API_TOKEN not set; using synthetic fallback only.");
        return [];
      }
      const url = "https://api.cloudflare.com/client/v4/radar/attacks/layer3/top/locations/origin?dateRange=1d&limit=20";
      const resRadar = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (!resRadar.ok) {
        const t = await resRadar.text();
        throw new Error(`HTTP ${resRadar.status} ${resRadar.statusText}: ${t.slice(0, 200)}…`);
      }
      const data = await resRadar.json();
      return data?.result?.top_0 ?? [];
    } catch (err) {
      console.error("Error fetching Cloudflare data:", err);
      return [];
    }
  }

  const list = await fetchCloudflareData();

  // Heartbeat to keep proxies from idling the stream
  const hb = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15000);

  // Emit frames
  const tick = setInterval(() => {
    const evt = list.length
      ? list[Math.floor(Math.random() * list.length)]
      : {
          src_country: ["US", "GB", "DE", "FR", "BR", "IN", "JP", "HK"][Math.floor(Math.random() * 8)],
          dst_country: "GLOBAL",
          intensity_index: Math.ceil(Math.random() * 5),
          attack_type: "Layer 3/4",
        };
    res.write(`data: ${JSON.stringify({ ts: Date.now(), ...evt })}\n\n`);
  }, 500);

  // Cleanup
  function close() {
    clearInterval(hb);
    clearInterval(tick);
    try { res.end(); } catch {}
  }
  req.on("close", close);
  req.on("aborted", close);
}
