export default async function handler(req, res) {
  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  // Fetch data from Cloudflare Radar
  async function fetchCloudflareData() {
    try {
      const token = process.env.CLOUDFLARE_API_TOKEN;
      if (!token) {
        console.warn("CLOUDFLARE_API_TOKEN not set; using synthetic fallback only.");
        return [];
      }

      const url =
        "https://api.cloudflare.com/client/v4/radar/attacks/layer3/top/locations/origin?dateRange=1d&limit=20";

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

  // Send random events every 500ms
  const list = await fetchCloudflareData();

  const timer = setInterval(() => {
    const evt =
      list.length > 0
        ? list[Math.floor(Math.random() * list.length)]
        : {
            src_country: ["US", "GB", "DE", "FR", "BR", "IN", "JP", "HK"][
              Math.floor(Math.random() * 8)
            ],
            dst_country: "GLOBAL",
            intensity_index: Math.ceil(Math.random() * 5),
            attack_type: "Layer 3/4",
          };

    res.write(`data: ${JSON.stringify({ ts: Date.now(), ...evt })}\n\n`);
  }, 500);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(timer);
  });
}
