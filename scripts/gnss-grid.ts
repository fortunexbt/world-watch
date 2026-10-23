// Builds the GNSS interference grid from one day of ADSB.lol globe_history.
// Usage:
//   tsx scripts/gnss-grid.ts --out <dir> [--workers <n>] <part.aa> <part.ab> ...
//   curl -sL <part.aa URL> <part.ab URL> | tsx scripts/gnss-grid.ts --out <dir>
// The split tar parts are read in order as one stream, from the files given or
// from stdin, and never extracted to disk or held in memory: the main thread
// walks the tar headers and hands each aircraft's gzipped trace to a worker,
// which inflates and scans it into fixed-size cell counters.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import {
  archiveRelease,
  GnssAccumulator,
  gnssGrid,
  gnssManifest,
  scanTrace,
} from "../src/shared/gnss.js";

/** Several traces per message: one transfer per batch rather than per aircraft. */
type Batch = { buffer: ArrayBuffer; ends: number[] };
const BATCH_BYTES = 4 * 1024 * 1024,
  IN_FLIGHT = 2;

function scanBatch(acc: GnssAccumulator, { buffer, ends }: Batch, day: number) {
  let start = 0;
  for (const end of ends) {
    scanTrace(gunzipSync(new Uint8Array(buffer, start, end - start)), acc, day);
    start = end;
  }
}

if (!isMainThread) {
  const acc = new GnssAccumulator();
  parentPort!.on("message", (batch: Batch | null) => {
    if (batch) {
      scanBatch(acc, batch, workerData.day);
      parentPort!.postMessage("done");
    } else
      parentPort!.postMessage(
        { aircraft: acc.aircraft, degraded: acc.degraded, counts: acc.counts },
        [acc.aircraft.buffer, acc.degraded.buffer],
      );
  });
} else await main();

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      workers: {
        type: "string",
        default: String(Math.max(0, Math.min(4, availableParallelism() - 1))),
      },
    },
  });
  const workerCount = Number(values.workers);
  if (!values.out || !Number.isInteger(workerCount) || workerCount < 0)
    throw Error("usage: gnss-grid --out <dir> [--workers <n>] [tar parts...]");
  const started = performance.now(),
    cpu = process.cpuUsage();
  const total = new GnssAccumulator();
  let day = NaN,
    readme = "",
    inputBytes = 0,
    traceBytes = 0;
  const pool: { worker: Worker; busy: number }[] = [];
  let wake: (() => void) | undefined;
  const send = async (batch: Batch) => {
    if (!workerCount) return scanBatch(total, batch, day);
    if (!pool.length)
      for (let i = 0; i < workerCount; i++) {
        const worker = new Worker(new URL(import.meta.url), {
          workerData: { day },
          // Each trace is garbage once scanned; a small heap collects it promptly
          // instead of letting every worker grow to hundreds of megabytes.
          resourceLimits: { maxOldGenerationSizeMb: 64 },
        });
        const slot = { worker, busy: 0 };
        worker.on("message", (m) => {
          if (m !== "done") return;
          slot.busy--;
          wake?.();
        });
        worker.on("error", (e) => {
          console.error(e);
          process.exit(1);
        });
        pool.push(slot);
      }
    let slot = pool.reduce((a, b) => (b.busy < a.busy ? b : a));
    while (slot.busy >= IN_FLIGHT) {
      await new Promise<void>((resolve) => (wake = resolve));
      slot = pool.reduce((a, b) => (b.busy < a.busy ? b : a));
    }
    slot.busy++;
    slot.worker.postMessage(batch, [batch.buffer]);
  };

  let batch = new Uint8Array(BATCH_BYTES),
    used = 0,
    ends: number[] = [];
  const flush = async () => {
    if (!ends.length) return;
    const full = { buffer: batch.buffer, ends };
    batch = new Uint8Array(BATCH_BYTES);
    used = 0;
    ends = [];
    await send(full);
  };
  for await (const member of tarMembers(
    input(positionals),
    (n) => (inputBytes += n),
  )) {
    if (member.name === "./README.txt") {
      readme = new TextDecoder().decode(
        await member.read(new Uint8Array(member.size)),
      );
      continue;
    }
    if (
      !/^\.\/traces\/[0-9a-f]{2}\/trace_full_~?[0-9a-f]{6}\.json$/.test(
        member.name,
      )
    )
      continue;
    const size = member.size;
    traceBytes += size;
    let bytes: Uint8Array;
    if (size > BATCH_BYTES) {
      await flush();
      bytes = await member.read(new Uint8Array(size));
    } else {
      if (used + size > BATCH_BYTES) await flush();
      bytes = await member.read(batch.subarray(used, used + size));
      used += size;
      ends.push(used);
    }
    if (Number.isNaN(day)) {
      // The first trace fixes the UTC day; any trace from another day is counted and skipped.
      const match = /"timestamp":\s*(\d+)/.exec(
        new TextDecoder().decode(gunzipSync(bytes).subarray(0, 4096)),
      );
      if (!match) throw Error("invalid_trace");
      day = Math.floor(Number(match[1]) / 86400) * 86400;
    }
    if (size > BATCH_BYTES)
      await send({ buffer: bytes.buffer as ArrayBuffer, ends: [size] });
  }
  await flush();
  for (const slot of pool) {
    const result = await new Promise<any>((resolve) => {
      slot.worker.on("message", (m) => m !== "done" && resolve(m));
      slot.worker.postMessage(null);
    });
    total.merge(result);
    await slot.worker.terminate();
  }
  if (Number.isNaN(day)) throw Error("no trace_full files in the archive");
  const date = new Date(day * 1000).toISOString().slice(0, 10);
  const release = archiveRelease(readme, date);
  const { grid, counts } = gnssGrid(total, date);
  const text = JSON.stringify(grid);
  const file = `gnss-${date}.json`;
  const manifest = gnssManifest(
    date,
    release,
    counts,
    {
      file,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    },
    new Date().toISOString(),
  );
  const out = path.resolve(values.out);
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, file), text);
  await writeFile(
    path.join(out, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  const seconds = (performance.now() - started) / 1000,
    used_cpu = process.cpuUsage(cpu);
  console.log(
    JSON.stringify(
      {
        date,
        release,
        workers: workerCount,
        seconds: +seconds.toFixed(2),
        cpu_seconds: +((used_cpu.user + used_cpu.system) / 1e6).toFixed(2),
        input_mb: +(inputBytes / 1e6).toFixed(1),
        input_mb_per_s: +(inputBytes / 1e6 / seconds).toFixed(1),
        trace_mb: +(traceBytes / 1e6).toFixed(1),
        reports_per_s: Math.round(counts.reports / seconds),
        peak_rss_mb: +(process.resourceUsage().maxRSS / 1024).toFixed(0),
        grid_bytes: manifest.grid.bytes,
        ...counts,
      },
      null,
      2,
    ),
  );
}

async function* input(files: string[]) {
  if (!files.length || (files.length === 1 && files[0] === "-"))
    yield* process.stdin as AsyncIterable<Buffer>;
  for (const file of files)
    yield* createReadStream(file, {
      highWaterMark: 1024 * 1024,
    }) as AsyncIterable<Buffer>;
}

/**
 * POSIX and GNU tar members from a byte stream. Each member is read into the
 * caller's buffer or skipped before the next is yielded; nothing else is held.
 */
async function* tarMembers(
  chunks: AsyncIterable<Buffer>,
  counted: (bytes: number) => void,
) {
  const source = chunks[Symbol.asyncIterator]();
  let chunk: Buffer = Buffer.alloc(0),
    offset = 0;
  /** Copies (into) or skips the next n bytes. */
  const take = async (n: number, into?: Uint8Array) => {
    let done = 0;
    while (done < n) {
      if (offset === chunk.length) {
        const next = await source.next();
        if (next.done) throw Error("truncated_tar");
        chunk = next.value;
        offset = 0;
        counted(chunk.length);
      }
      const step = Math.min(n - done, chunk.length - offset);
      into?.set(chunk.subarray(offset, offset + step), done);
      offset += step;
      done += step;
    }
  };
  const header = new Uint8Array(512);
  let longName: string | undefined;
  while (true) {
    try {
      await take(512, header);
    } catch (e) {
      // GNU tar may end without the two zero blocks when a split part is the last one.
      if (e instanceof Error && e.message === "truncated_tar") return;
      throw e;
    }
    if (header.every((b) => b === 0)) return;
    const field = (start: number, length: number) => {
      const bytes = header.subarray(start, start + length);
      const end = bytes.indexOf(0);
      return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
    };
    const size =
      header[124] & 0x80
        ? header.subarray(125, 136).reduce((n, b) => n * 256 + b, 0)
        : parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const padded = Math.ceil(size / 512) * 512;
    const prefix = field(345, 155);
    const name =
      longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    if (type === "L") {
      const bytes = new Uint8Array(padded);
      await take(padded, bytes);
      longName = new TextDecoder()
        .decode(bytes.subarray(0, size))
        .replace(/\0.*$/s, "");
      continue;
    }
    let read = false;
    const member = {
      name: type === "0" || type === "7" ? name : "",
      size,
      /** Copies the member into a view of exactly its size. */
      read: async (into: Uint8Array) => {
        read = true;
        await take(size, into);
        await take(padded - size);
        return into;
      },
    };
    yield member;
    if (!read) await take(padded);
  }
}
