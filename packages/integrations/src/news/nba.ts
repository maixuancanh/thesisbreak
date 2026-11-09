import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const INDEX = "https://official.nba.com/nba-injury-report-2026-27-season";
const teams: Record<string, string> = {
  ATL: "Atlanta Hawks",
  BOS: "Boston Celtics",
  BKN: "Brooklyn Nets",
  CHA: "Charlotte Hornets",
  CHI: "Chicago Bulls",
  CLE: "Cleveland Cavaliers",
  DAL: "Dallas Mavericks",
  DEN: "Denver Nuggets",
  DET: "Detroit Pistons",
  GSW: "Golden State Warriors",
  HOU: "Houston Rockets",
  IND: "Indiana Pacers",
  LAC: "LA Clippers",
  LAL: "Los Angeles Lakers",
  MEM: "Memphis Grizzlies",
  MIA: "Miami Heat",
  MIL: "Milwaukee Bucks",
  MIN: "Minnesota Timberwolves",
  NOP: "New Orleans Pelicans",
  NYK: "New York Knicks",
  OKC: "Oklahoma City Thunder",
  ORL: "Orlando Magic",
  PHI: "Philadelphia 76ers",
  PHX: "Phoenix Suns",
  POR: "Portland Trail Blazers",
  SAC: "Sacramento Kings",
  SAS: "San Antonio Spurs",
  TOR: "Toronto Raptors",
  UTA: "Utah Jazz",
  WAS: "Washington Wizards",
};
export interface NbaItem {
  id: string;
  url: string;
  title: string;
  text: string;
  publishedAt: string | null;
  retrievedAt: string;
  eventDate: string | null;
  teams: string[];
  player?: string;
  status?: string;
}
export interface NbaResult {
  source: "nba-official";
  state: "available" | "unavailable" | "invalid";
  items: NbaItem[];
}

// Each PDF is isolated: a hostile document cannot retain unbounded heap or run indefinitely.
function extractPdf(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=96",
        "--input-type=module",
        "-e",
        `
      import {PDFParse} from 'pdf-parse';
      const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk);
      const parser=new PDFParse({data:new Uint8Array(Buffer.concat(chunks)),stopAtErrors:true,isEvalSupported:false,maxImageSize:0});
      try { const info=await parser.getInfo(); if(info.total>20) throw Error('page limit');
        const result=await parser.getText(); if(result.text.length>1000000) throw Error('text limit');
        process.stdout.write(JSON.stringify({text:result.text}));
      } finally { await parser.destroy(); }
    `,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PDF timeout"));
    }, 12000);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 1200000) {
        child.kill();
        reject(new Error("text limit"));
      }
    });
    child.stderr.resume();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(output) as { text: string };
        if (code !== 0 || typeof value.text !== "string")
          throw Error("Invalid PDF");
        resolve(value.text);
      } catch {
        reject(new Error("Invalid PDF"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
}

async function read(
  url: string,
  transport: typeof fetch,
  maxBytes: number,
): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !(
      url === INDEX ||
      (parsed.hostname === "ak-static.cms.nba.com" &&
        /^\/referee\/injury\/Injury-Report_\d{4}-\d{2}-\d{2}_\d{2}_\d{2}(?:AM|PM)\.pdf$/.test(
          parsed.pathname,
        ) &&
        !parsed.search &&
        !parsed.hash)
    )
  )
    throw new Error("Unsafe URL");
  const response = await transport(url, {
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok || !response.body) throw new Error("Unavailable");
  if (Number(response.headers.get("content-length")) > maxBytes)
    throw new Error("Byte limit");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maxBytes) throw new Error("Byte limit");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function parseRows(text: string, url: string, retrievedAt: string): NbaItem[] {
  const items: NbaItem[] = [];
  let date = "";
  let matchup: string[] = [];
  let team = "";
  let last: NbaItem | undefined;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim().replace(/\s+/g, " ");
    if (
      !line ||
      /^Injury Report:|^Page \d+ of \d+$|^Game Date Game Time|^-- \d+ of \d+ --$/.test(
        line,
      )
    )
      continue;
    const d = /^(\d{2})\/(\d{2})\/(\d{4})\s+/.exec(line);
    if (d) {
      date = `${d[3]}-${d[1]}-${d[2]}`;
      if (new Date(date).toISOString().slice(0, 10) !== date)
        throw new Error("Invalid date");
      line = line.slice(d[0].length);
      last = undefined;
    }
    line = line.replace(/^\d{2}:\d{2} \(ET\)\s+/, "");
    const m = /^([A-Z]{3})@([A-Z]{3})\s+/.exec(line);
    if (m) {
      if (!teams[m[1]!] || !teams[m[2]!]) throw new Error("Unknown matchup");
      matchup = [teams[m[1]!]!, teams[m[2]!]!];
      team = "";
      last = undefined;
      line = line.slice(m[0].length);
    }
    const found = Object.values(teams).find((name) =>
      line.startsWith(`${name} `),
    );
    if (found) {
      team = found;
      last = undefined;
      line = line.slice(found.length + 1);
    }
    if (line === "NOT YET SUBMITTED") {
      if (!date || !matchup.includes(team)) throw new Error("Missing context");
      last = undefined;
      continue;
    }
    const row =
      /^([^,]+, .+?) (Out|Doubtful|Questionable|Probable|Available)(?: (.*))?$/.exec(
        line,
      );
    if (row) {
      if (!date || !matchup.includes(team)) throw new Error("Missing context");
      const player = row[1]!,
        status = row[2]!;
      last = {
        id: createHash("sha256")
          .update(`${url}|${date}|${team}|${player}`)
          .digest("hex"),
        url,
        title: `${team}: ${player} — ${status}`,
        text: `${date} ${team}: ${player} — ${status}${row[3] ? `. ${row[3]}` : ""}`,
        publishedAt: null,
        retrievedAt,
        eventDate: date,
        teams: [...matchup],
        player,
        status,
      };
      items.push(last);
    } else if (
      last &&
      !/[,@]|NOT YET SUBMITTED/.test(line) &&
      line.length < 250
    ) {
      last.text += ` ${line}`;
    } else throw new Error("Ambiguous row");
  }
  if (
    !items.length ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    throw new Error("No unique rows");
  return items;
}

export async function fetchNbaReport(
  options: { transport?: typeof fetch; now?: Date } = {},
): Promise<NbaResult> {
  const result = (
    state: NbaResult["state"],
    items: NbaItem[] = [],
  ): NbaResult => ({ source: "nba-official", state, items });
  const transport = options.transport ?? fetch;
  let html: string;
  try {
    html = new TextDecoder().decode(
      await read(INDEX, transport, 2 * 1024 * 1024),
    );
  } catch {
    return result("unavailable");
  }
  const links = [
    ...html.matchAll(
      /href\s*=\s*["'](https:\/\/ak-static\.cms\.nba\.com\/referee\/injury\/Injury-Report_(\d{4}-\d{2}-\d{2})_(\d{2})_(\d{2})(AM|PM)\.pdf)["']/gi,
    ),
  ]
    .map((m) => ({
      url: m[1]!,
      key: `${m[2]}T${String((Number(m[3]) % 12) + (m[5]?.toUpperCase() === "PM" ? 12 : 0)).padStart(2, "0")}:${m[4]}`,
    }))
    .sort((a, b) => b.key.localeCompare(a.key));
  if (!links[0]) return result("invalid");
  let bytes: Uint8Array;
  try {
    bytes = await read(links[0].url, transport, 5 * 1024 * 1024);
  } catch {
    return result("unavailable");
  }
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
    return result("invalid");
  try {
    return result(
      "available",
      parseRows(
        await extractPdf(bytes),
        links[0].url,
        (options.now ?? new Date()).toISOString(),
      ),
    );
  } catch {
    return result("invalid");
  }
}
