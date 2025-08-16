import 'dotenv/config';
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());

let cachedData = []; 
async function fetchCloudflareData() {
  try {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) {
      console.warn("CLOUDFLARE_API_TOKEN not set; using synthetic fallback only.");
      cachedData = [];
      return;
    }

    const url = "https://api.cloudflare.com/client/v4/radar/attacks/layer3/top/locations/origin?dateRange=1d&limit=20";
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${t.slice(0, 300)}…`);
    }

    const data = await res.json();
    const list = data?.result?.top_0 ?? []; 

    cachedData = list.map(row => ({
      src_country: row?.originCountryAlpha2 || "??",
      intensity_index: Number(row?.value ?? 1), 
      attack_type: "Layer 3/4",
      dst_country: "GLOBAL"
    }));

    const updated = data?.result?.meta?.lastUpdated || "unknown";
    console.log(`Fetched ${cachedData.length} countries from Radar (lastUpdated: ${updated})`);
  } catch (err) {
    console.error("Error fetching Cloudflare data:", err);
  }
}

await fetchCloudflareData();
setInterval(fetchCloudflareData, 5 * 60 * 1000);
app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();

  const send = () => {
    const evt =
      cachedData.length > 0
        ? cachedData[Math.floor(Math.random() * cachedData.length)]
        : {
            src_country: ["US","GB","DE","FR","BR","IN","JP","HK"][Math.floor(Math.random() * 8)],
            dst_country: "GLOBAL",
            intensity_index: Math.ceil(Math.random() * 5),
            attack_type: "Layer 3/4",
          };

    res.write(`data: ${JSON.stringify({ ts: Date.now(), ...evt })}\n\n`);
  };

  const timer = setInterval(send, 500);
  req.on("close", () => clearInterval(timer));
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
