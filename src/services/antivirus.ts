import net from "net";
import fs from "fs";
import { getConfig } from "../config.js";

export type MalwareScanResult =
  | {
      clean: true;
      infected: false;
      skipped: boolean;
      engine: "clamav" | "none";
      detail?: string;
    }
  | {
      clean: false;
      infected: true;
      skipped: false;
      engine: "clamav";
      threatName: string;
      detail: string;
    }
  | {
      clean: false;
      infected: false;
      skipped: false;
      engine: "clamav";
      detail: string;
    };

function parseClamavResponse(raw: string): MalwareScanResult {
  const text = raw.replace(/\0/g, "").trim();
  if (!text) {
    return {
      clean: false,
      infected: false,
      skipped: false,
      engine: "clamav",
      detail: "Empty response from clamd",
    };
  }

  if (text.endsWith("OK")) {
    return {
      clean: true,
      infected: false,
      skipped: false,
      engine: "clamav",
      detail: text,
    };
  }

  const foundMatch = text.match(/:\s(.+)\sFOUND$/i);
  if (foundMatch && foundMatch[1]) {
    return {
      clean: false,
      infected: true,
      skipped: false,
      engine: "clamav",
      threatName: foundMatch[1],
      detail: text,
    };
  }

  return {
    clean: false,
    infected: false,
    skipped: false,
    engine: "clamav",
    detail: text,
  };
}

async function scanBufferWithClamav(
  buffer: Buffer,
  host: string,
  port: number,
  timeoutMs: number
): Promise<MalwareScanResult> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      fn();
    };

    socket.setTimeout(timeoutMs);

    socket.on("connect", () => {
      try {
        // z-prefixed command uses null terminator instead of newline.
        socket.write(Buffer.from("zINSTREAM\0", "utf8"));
        const CHUNK = 64 * 1024;
        let offset = 0;
        while (offset < buffer.length) {
          const end = Math.min(offset + CHUNK, buffer.length);
          const part = buffer.subarray(offset, end);
          const len = Buffer.allocUnsafe(4);
          len.writeUInt32BE(part.length, 0);
          socket.write(len);
          socket.write(part);
          offset = end;
        }
        const endMarker = Buffer.alloc(4);
        endMarker.writeUInt32BE(0, 0);
        socket.write(endMarker);
      } catch (err) {
        finish(() => reject(err));
      }
    });

    socket.on("data", (data: Buffer) => {
      chunks.push(data);
    });

    socket.on("timeout", () => {
      finish(() => reject(new Error(`ClamAV scan timed out after ${timeoutMs}ms`)));
    });

    socket.on("error", (err) => {
      finish(() => reject(err));
    });

    socket.on("end", () => {
      const response = Buffer.concat(chunks).toString("utf8");
      finish(() => resolve(parseClamavResponse(response)));
    });
  });
}

async function pingClamav(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (payload: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(payload);
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      socket.write(Buffer.from("zPING\0", "utf8"));
    });
    socket.on("data", (data: Buffer) => {
      chunks.push(data);
    });
    socket.on("timeout", () => {
      finish({ ok: false, detail: `Timeout after ${timeoutMs}ms` });
    });
    socket.on("error", (err) => {
      finish({ ok: false, detail: err.message });
    });
    socket.on("end", () => {
      const response = Buffer.concat(chunks).toString("utf8").replace(/\0/g, "").trim();
      finish({
        ok: /PONG/i.test(response),
        detail: response || "No response from clamd",
      });
    });
  });
}

export async function scanUploadForMalware(
  buffer: Buffer
): Promise<MalwareScanResult> {
  const cfg = getConfig().files.antivirus;
  if (!cfg.enabled) {
    return {
      clean: true,
      infected: false,
      skipped: true,
      engine: "none",
    };
  }

  try {
    return await scanBufferWithClamav(
      buffer,
      cfg.clamavHost,
      cfg.clamavPort,
      cfg.timeoutMs
    );
  } catch (err) {
    return {
      clean: false,
      infected: false,
      skipped: false,
      engine: "clamav",
      detail: err instanceof Error ? err.message : "ClamAV scan failed",
    };
  }
}

export async function testAntivirusConnection(): Promise<{
  enabled: boolean;
  host: string;
  port: number;
  timeoutMs: number;
  ok: boolean;
  detail: string;
}> {
  const cfg = getConfig().files.antivirus;
  if (!cfg.enabled) {
    return {
      enabled: false,
      host: cfg.clamavHost,
      port: cfg.clamavPort,
      timeoutMs: cfg.timeoutMs,
      ok: false,
      detail: "Antivirus scanning is currently disabled in config",
    };
  }
  const result = await pingClamav(cfg.clamavHost, cfg.clamavPort, cfg.timeoutMs);
  return {
    enabled: true,
    host: cfg.clamavHost,
    port: cfg.clamavPort,
    timeoutMs: cfg.timeoutMs,
    ok: result.ok,
    detail: result.detail,
  };
}

function detectPackageManager(): "apt" | "dnf" | "yum" | "unknown" {
  if (fs.existsSync("/usr/bin/apt-get")) return "apt";
  if (fs.existsSync("/usr/bin/dnf")) return "dnf";
  if (fs.existsSync("/usr/bin/yum")) return "yum";
  return "unknown";
}

export function getAntivirusInstallInstructions() {
  const pm = detectPackageManager();
  let installCommand = "";
  let serviceName = "";
  if (pm === "apt") {
    installCommand = "sudo apt-get update && sudo apt-get install -y clamav clamav-daemon";
    serviceName = "clamav-daemon";
  } else if (pm === "dnf") {
    installCommand = "sudo dnf install -y clamav clamav-update clamd";
    serviceName = "clamd@scan (or clamd, depending on distro)";
  } else if (pm === "yum") {
    installCommand = "sudo yum install -y clamav clamav-update clamd";
    serviceName = "clamd@scan (or clamd, depending on distro)";
  } else {
    installCommand = "Install ClamAV/clamd using your distro package manager.";
    serviceName = "clamd";
  }

  return {
    packageManager: pm,
    installCommand,
    enableServiceCommand:
      pm === "apt"
        ? "sudo systemctl enable --now clamav-daemon"
        : "sudo systemctl enable --now clamd@scan",
    restartServiceCommand:
      pm === "apt"
        ? "sudo systemctl restart clamav-daemon"
        : "sudo systemctl restart clamd@scan",
    expectedService: serviceName,
    note:
      "After installing, enable malware scanning in Admin > Configuration > File Storage and test the connection.",
  };
}
