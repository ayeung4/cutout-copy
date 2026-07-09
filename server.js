import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REMOVE_BG_ENDPOINT = "https://api.remove.bg/v1.0/removebg";
const PORT = Number(process.env.PORT || 8787);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), ".data");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");

const server = http.createServer(async (request, response) => {
  try {
    setCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "cutout-copy-backend",
        hasRemoveBgApiKey: Boolean(process.env.REMOVE_BG_API_KEY)
      });
      return;
    }

    if (request.method === "GET" && request.url === "/usage/status") {
      await handleUsageStatus(request, response);
      return;
    }

    if (request.method === "POST" && request.url === "/remove-background") {
      await handleRemoveBackground(request, response);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, { error: error?.message || "Unexpected server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Cutout Copy backend listening on http://localhost:${PORT}`);
});

async function handleRemoveBackground(request, response) {
  const apiKey = process.env.REMOVE_BG_API_KEY;
  const startedAt = Date.now();
  const metadata = requestMetadata(request);

  if (!apiKey) {
    await recordEvent({
      ...metadata,
      outcome: "failure",
      errorCode: "missing_api_key",
      durationMs: Date.now() - startedAt
    });
    sendJson(response, 500, { error: "REMOVE_BG_API_KEY is not configured" });
    return;
  }

  const usageKey = usageKeyForRequest(request);

  const contentType = request.headers["content-type"] || "";
  const formData = new FormData();

  if (contentType.includes("application/json")) {
    const body = await readBody(request, 64 * 1024);
    const payload = JSON.parse(body.toString("utf8"));

    if (!payload.imageUrl) {
      await recordEvent({
        ...metadata,
        outcome: "failure",
        errorCode: "missing_image_url",
        durationMs: Date.now() - startedAt
      });
      sendJson(response, 400, { error: "imageUrl is required" });
      return;
    }

    formData.append("image_url", payload.imageUrl);
  } else {
    const body = await readBody(request, MAX_IMAGE_BYTES);
    const filename = cleanFilename(request.headers["x-filename"] || "image.png");
    const blob = new Blob([body], { type: contentType || "application/octet-stream" });
    formData.append("image_file", blob, filename);
  }

  formData.append("size", "auto");

  const removeBgResponse = await fetch(REMOVE_BG_ENDPOINT, {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey
    },
    body: formData
  });

  if (!removeBgResponse.ok) {
    const detail = await removeBgResponse.text().catch(() => "");
    await recordEvent({
      ...metadata,
      outcome: "failure",
      errorCode: "remove_bg_error",
      statusCode: removeBgResponse.status,
      durationMs: Date.now() - startedAt
    });
    sendJson(response, removeBgResponse.status, {
      error: "remove.bg request failed",
      detail: detail.slice(0, 500)
    });
    return;
  }

  const result = Buffer.from(await removeBgResponse.arrayBuffer());
  await incrementUsage(usageKey);
  await recordEvent({
    ...metadata,
    outcome: "success",
    statusCode: 200,
    outputBytes: result.length,
    durationMs: Date.now() - startedAt
  });
  response.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": result.length,
    "Cache-Control": "no-store"
  });
  response.end(result);
}

async function handleUsageStatus(request, response) {
  const usageKey = usageKeyForRequest(request);
  const usage = await getUsageStatus(usageKey);
  const actions = await getActionBreakdown(usageKey);
  const global = await getGlobalUsageSummary();

  sendJson(response, 200, {
    ok: true,
    used: usage.used,
    actions,
    global,
    month: currentMonthKey()
  });
}

async function recordEvent(event) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(EVENTS_FILE, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event
  })}\n`, { flag: "a" });
}

function requestMetadata(request) {
  const pageUrl = String(request.headers["x-page-url"] || "");
  const imageUrl = String(request.headers["x-image-url"] || "");

  return {
    action: cleanToken(request.headers["x-cutout-action"] || "unknown"),
    pageDomain: domainFromUrl(pageUrl),
    imageDomain: domainFromUrl(imageUrl),
    contentType: String(request.headers["content-type"] || ""),
    visitorKey: usageKeyForRequest(request)
  };
}

function domainFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function cleanToken(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "unknown";
}

async function getUsageStatus(usageKey) {
  const usage = await readUsage();
  const month = currentMonthKey();
  const used = usage[month]?.[usageKey] || 0;

  return {
    used
  };
}

async function getActionBreakdown(usageKey) {
  const month = currentMonthKey();
  const actions = {
    copy: 0,
    download: 0,
    unknown: 0
  };

  try {
    const content = await readFile(EVENTS_FILE, "utf8");

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      const event = JSON.parse(line);

      if (
        event.outcome !== "success" ||
        event.visitorKey !== usageKey ||
        !String(event.timestamp || "").startsWith(month)
      ) {
        continue;
      }

      if (event.action === "copy" || event.action === "download") {
        actions[event.action] += 1;
      } else {
        actions.unknown += 1;
      }
    }
  } catch {
    return actions;
  }

  return actions;
}

async function getGlobalUsageSummary() {
  const month = currentMonthKey();
  const summary = {
    total: 0,
    success: 0,
    failure: 0,
    actions: {
      copy: 0,
      download: 0,
      unknown: 0
    },
    topPageDomains: [],
    averageDurationMs: 0
  };
  const pageDomains = new Map();
  let durationTotal = 0;
  let durationCount = 0;

  try {
    const content = await readFile(EVENTS_FILE, "utf8");

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      const event = JSON.parse(line);

      if (!String(event.timestamp || "").startsWith(month)) {
        continue;
      }

      summary.total += 1;

      if (event.outcome === "success") {
        summary.success += 1;
      } else if (event.outcome === "failure") {
        summary.failure += 1;
      }

      if (event.action === "copy" || event.action === "download") {
        summary.actions[event.action] += 1;
      } else {
        summary.actions.unknown += 1;
      }

      if (event.pageDomain) {
        pageDomains.set(event.pageDomain, (pageDomains.get(event.pageDomain) || 0) + 1);
      }

      if (Number.isFinite(event.durationMs)) {
        durationTotal += event.durationMs;
        durationCount += 1;
      }
    }
  } catch {
    return summary;
  }

  summary.topPageDomains = Array.from(pageDomains.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([domain, count]) => ({ domain, count }));
  summary.averageDurationMs = durationCount > 0 ? Math.round(durationTotal / durationCount) : 0;

  return summary;
}

async function incrementUsage(usageKey) {
  const usage = await readUsage();
  const month = currentMonthKey();
  usage[month] ||= {};
  usage[month][usageKey] = (usage[month][usageKey] || 0) + 1;
  await writeUsage(usage);
}

async function readUsage() {
  try {
    return JSON.parse(await readFile(USAGE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeUsage(usage) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(USAGE_FILE, JSON.stringify(usage, null, 2));
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function usageKeyForRequest(request) {
  const ip = request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown";
  return `visitor:${String(ip).split(",")[0].trim()}`;
}

function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    request.on("data", (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > maxBytes) {
        request.destroy();
        reject(new Error("Request body is too large"));
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    request.on("error", reject);
  });
}

function cleanFilename(filename) {
  return String(filename)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "image.png";
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Cutout-Action, X-Page-Url, X-Image-Url");
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}
