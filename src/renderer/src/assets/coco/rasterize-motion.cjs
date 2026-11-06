// Electron main script for generate-motion.mjs: rasterize SVG palette fields to PNG
// with Chromium's own renderer (gradients + baked blur), so runtime frames only
// draw cached bitmaps. Usage: electron rasterize-motion.cjs <jobs.json>
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const jobs = JSON.parse(readFileSync(process.argv[process.argv.length - 1], "utf8"));
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL("about:blank");
  for (const job of jobs) {
    const svg = Buffer.from(readFileSync(job.svg, "utf8")).toString("base64");
    const png = await win.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = "data:image/svg+xml;base64,${svg}";
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = ${job.px};
      canvas.getContext("2d").drawImage(image, 0, 0, ${job.px}, ${job.px});
      return canvas.toDataURL("image/png").split(",")[1];
    })()`);
    writeFileSync(job.out, Buffer.from(png, "base64"));
  }
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
