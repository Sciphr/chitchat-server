import os from "os";
import type { Server } from "socket.io";
import { getDb } from "../db/database.js";

type Sample = {
  ts: number;
  apiRequestsTotal: number;
  apiErrorsTotal: number;
  apiBytesInTotal: number;
  apiBytesOutTotal: number;
};

const state = {
  startedAt: Date.now(),
  apiRequestsTotal: 0,
  apiErrorsTotal: 0,
  apiBytesInTotal: 0,
  apiBytesOutTotal: 0,
  routeCounters: new Map<string, number>(),
  wsAcceptedTotal: 0,
  wsPeak: 0,
  io: null as Server | null,
  samples: [] as Sample[],
};

function pushSample() {
  const now = Date.now();
  state.samples.push({
    ts: now,
    apiRequestsTotal: state.apiRequestsTotal,
    apiErrorsTotal: state.apiErrorsTotal,
    apiBytesInTotal: state.apiBytesInTotal,
    apiBytesOutTotal: state.apiBytesOutTotal,
  });
  const cutoff = now - 5 * 60 * 1000;
  state.samples = state.samples.filter((sample) => sample.ts >= cutoff);
}

function estimate1mRate<T extends keyof Sample>(
  key: T,
  fallbackNow: number
): number {
  const now = Date.now();
  const baselineTime = now - 60 * 1000;
  const baseline =
    [...state.samples]
      .reverse()
      .find((sample) => sample.ts <= baselineTime) ?? state.samples[0];

  if (!baseline) return fallbackNow;
  const elapsedSec = Math.max(1, (now - baseline.ts) / 1000);
  const delta = Number(stateSampleNow()[key]) - Number(baseline[key]);
  return delta / elapsedSec;
}

function stateSampleNow(): Sample {
  return {
    ts: Date.now(),
    apiRequestsTotal: state.apiRequestsTotal,
    apiErrorsTotal: state.apiErrorsTotal,
    apiBytesInTotal: state.apiBytesInTotal,
    apiBytesOutTotal: state.apiBytesOutTotal,
  };
}

export function trackApiUsage(args: {
  method: string;
  path: string;
  statusCode: number;
  requestBytes: number;
  responseBytes: number;
}) {
  state.apiRequestsTotal += 1;
  if (args.statusCode >= 400) state.apiErrorsTotal += 1;
  state.apiBytesInTotal += Math.max(0, args.requestBytes);
  state.apiBytesOutTotal += Math.max(0, args.responseBytes);
  const routeKey = `${args.method.toUpperCase()} ${args.path}`;
  state.routeCounters.set(routeKey, (state.routeCounters.get(routeKey) ?? 0) + 1);
  pushSample();
}

export function bindSocketServer(io: Server) {
  state.io = io;
  io.on("connection", () => {
    state.wsAcceptedTotal += 1;
    const current = io.engine.clientsCount;
    state.wsPeak = Math.max(state.wsPeak, current);
  });
}

export function getResourceSnapshot() {
  const db = getDb();
  const onlineUsersRow = db
    .prepare("SELECT COUNT(*) as count FROM users WHERE status = 'online'")
    .get() as { count: number };
  const totalUsersRow = db.prepare("SELECT COUNT(*) as count FROM users").get() as {
    count: number;
  };

  const mem = process.memoryUsage();
  const cpuLoads = os.loadavg();
  const cpus = os.cpus().length;
  const uptimeSec = Math.floor(process.uptime());

  const now = stateSampleNow();
  const reqRate1m = estimate1mRate("apiRequestsTotal", 0);
  const errRate1m = estimate1mRate("apiErrorsTotal", 0);
  const inRate1m = estimate1mRate("apiBytesInTotal", 0);
  const outRate1m = estimate1mRate("apiBytesOutTotal", 0);

  const topRoutes = [...state.routeCounters.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([route, hits]) => ({ route, hits }));

  return {
    generatedAt: new Date().toISOString(),
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSec,
    },
    system: {
      cpuCores: cpus,
      loadAvg1m: cpuLoads[0] ?? 0,
      loadAvg5m: cpuLoads[1] ?? 0,
      loadAvg15m: cpuLoads[2] ?? 0,
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem(),
      usedMemBytes: Math.max(0, os.totalmem() - os.freemem()),
    },
    processMemory: {
      rssBytes: mem.rss,
      heapTotalBytes: mem.heapTotal,
      heapUsedBytes: mem.heapUsed,
      externalBytes: mem.external,
      arrayBuffersBytes: mem.arrayBuffers,
    },
    api: {
      requestsTotal: now.apiRequestsTotal,
      errorsTotal: now.apiErrorsTotal,
      bytesInTotal: now.apiBytesInTotal,
      bytesOutTotal: now.apiBytesOutTotal,
      requestsPerSecond1m: reqRate1m,
      errorsPerSecond1m: errRate1m,
      bytesInPerSecond1m: inRate1m,
      bytesOutPerSecond1m: outRate1m,
      topRoutes,
    },
    connections: {
      websocketCurrent: state.io?.engine.clientsCount ?? 0,
      websocketPeak: state.wsPeak,
      websocketAcceptedTotal: state.wsAcceptedTotal,
      usersOnline: onlineUsersRow.count,
      usersTotal: totalUsersRow.count,
    },
    notes: {
      mediaPlane:
        "Voice/video media traffic is typically carried by LiveKit directly between clients/SFU, not the app API server process.",
    },
  };
}

