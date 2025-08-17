export default async function handler(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  // Example: synthetic events every 2s
  setInterval(() => {
    const evt = {
      src_country: ["US","RU","BR","CN","DE"][Math.floor(Math.random()*5)],
      intensity_index: Math.random() * 10 + 1
    };
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }, 2000);
}
