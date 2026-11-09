import { z } from "zod";
import { CatalogError, TatumCatalog } from "./catalog";

// Polymarket CTF Exchange V2 Polygon deployments and OrdersMatched ABI.
const exchanges = [
  "0xe111180000d2663c0091e4f400237545b87b996b",
  "0xe2222d279d744050d28e00520010520000310f59",
];
const matchTopic =
  "0x174b3811690657c217184f89418266767c87e4805d09680c39fc9c031c0cab7c";
const hash = z.string().regex(/^0x[\da-f]{64}$/i);
const quantity = z.string().regex(/^0x[\da-f]+$/i);
const block = z.object({ number: quantity, timestamp: quantity });
const log = z.object({
  address: z.string(),
  topics: z.array(hash).length(3),
  data: z.string().regex(/^0x[\da-f]{256}$/i),
  transactionHash: hash,
  logIndex: quantity,
  blockNumber: quantity,
  removed: z.literal(false),
});

export async function readTatumOutcomeTokens(
  key: string,
  conditionId: string,
  reserve?: (cost: number) => Promise<void>,
) {
  const { data } = await new TatumCatalog(key, fetch, reserve).get(
    "polymarket",
    conditionId,
  );
  return z
    .array(
      z.object({
        name: z.string().min(1),
        tokenId: z.string().regex(/^\d{1,78}$/),
      }),
    )
    .length(2)
    .refine((rows) => rows[0]?.tokenId !== rows[1]?.tokenId)
    .parse(data.outcomes);
}

export async function readPolygonActivity(input: {
  apiKey: string;
  conditionId: string;
  outcomes: { name: string; tokenId: string }[];
  reserve: () => Promise<void>;
  signal?: AbortSignal | undefined;
  // Historical investigations supply a reviewed, bounded Polygon block range.
  range?: { first: bigint; last: bigint };
  around?: Date;
}) {
  async function rpc<T>(
    method: string,
    params: unknown[],
    schema: z.ZodType<T>,
  ) {
    input.signal?.throwIfAborted();
    await input.reserve();
    const timeout = AbortSignal.timeout(8_000);
    const response = await fetch("https://polygon-mainnet.gateway.tatum.io", {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": input.apiKey,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: input.signal ? AbortSignal.any([timeout, input.signal]) : timeout,
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      throw new CatalogError(
        "PROVIDER_RATE_LIMITED",
        retryAfter > 0 ? retryAfter : undefined,
      );
    }
    if (!response.ok) throw new CatalogError("PROVIDER_UNAVAILABLE");
    return z
      .object({ jsonrpc: z.literal("2.0"), id: z.literal(1), result: schema })
      .parse(await response.json()).result;
  }
  const hex = (value: bigint) => "0x" + value.toString(16);
  const latest = await rpc("eth_getBlockByNumber", ["finalized", false], block);
  const final = BigInt(latest.number);
  let last = input.range?.last ?? final;
  let first = input.range?.first ?? last - 23n;
  if (input.around && !input.range) {
    const seconds = Math.floor(input.around.getTime() / 1000);
    if (
      !Number.isSafeInteger(seconds) ||
      seconds <= 0 ||
      BigInt(seconds) >= BigInt(latest.timestamp)
    )
      throw new CatalogError("INVALID_BLOCK_WINDOW");
    let low = 0n;
    let high = final;
    while (high - low > 1n) {
      const mid = (low + high) / 2n;
      const candidate = await rpc(
        "eth_getBlockByNumber",
        [hex(mid), false],
        block,
      );
      if (BigInt(candidate.number) !== mid)
        throw new CatalogError("INVALID_PROVIDER_RESPONSE");
      if (BigInt(candidate.timestamp) < BigInt(seconds)) low = mid;
      else high = mid;
    }
    first = high > 63n ? high - 63n : 0n;
    last = high + 63n < final ? high + 63n : final;
  }
  if (first < 0n || last < first || last > final || last - first >= 128n)
    throw new CatalogError("INVALID_BLOCK_WINDOW");
  const start = await rpc("eth_getBlockByNumber", [hex(first), false], block);
  const end =
    last === final
      ? latest
      : await rpc("eth_getBlockByNumber", [hex(last), false], block);
  const entries: z.infer<typeof log>[] = [];
  for (let from = first; from <= last; from += 32n) {
    const to = from + 31n < last ? from + 31n : last;
    entries.push(...await rpc(
    "eth_getLogs",
    [
      {
        fromBlock: hex(from),
        toBlock: hex(to),
        address: exchanges,
        topics: [matchTopic],
      },
    ],
    z.array(log),
    ));
  }
  if (
    BigInt(start.number) !== first ||
    BigInt(end.number) !== last ||
    BigInt(start.timestamp) > BigInt(end.timestamp)
  )
    throw new CatalogError("INVALID_PROVIDER_RESPONSE");
  const seen = new Set<string>();
  const matches = entries.flatMap((entry) => {
    const number = BigInt(entry.blockNumber);
    if (
      !exchanges.includes(entry.address.toLowerCase()) ||
      entry.topics[0]?.toLowerCase() !== matchTopic ||
      number < first ||
      number > last
    )
      throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    const key =
      entry.transactionHash.toLowerCase() + ":" + BigInt(entry.logIndex);
    if (seen.has(key)) return [];
    seen.add(key);
    const words = entry.data.slice(2).match(/.{64}/g)!;
    const [side, token, maker, taker] = words.map((word) =>
      BigInt("0x" + word),
    ) as [bigint, bigint, bigint, bigint];
    const outcome = input.outcomes.find(
      (item) => BigInt(item.tokenId) === token,
    );
    if (!outcome) return [];
    const collateral = side === 0n ? maker : taker;
    const shares = side === 0n ? taker : maker;
    if (side > 1n || collateral <= 0n || shares <= 0n || collateral > shares)
      throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    return [
      {
        outcome: outcome.name,
        collateral: Number(collateral) / 1e6,
        shares: Number(shares) / 1e6,
        price: Number(collateral) / Number(shares),
        block: Number(number),
        transactionHash: entry.transactionHash,
      },
    ];
  });
  const time = (value: string) =>
    new Date(Number(BigInt(value)) * 1000).toISOString();
  return {
    conditionId: input.conditionId,
    network: "Polygon Mainnet",
    firstBlock: Number(first),
    lastBlock: Number(last),
    windowStart: time(start.timestamp),
    windowEnd: time(end.timestamp),
    outcomes: input.outcomes.map(({ name }) => {
      const fills = matches.filter((match) => match.outcome === name);
      const collateral = fills.reduce(
        (sum, match) => sum + match.collateral,
        0,
      );
      const shares = fills.reduce((sum, match) => sum + match.shares, 0);
      return {
        name,
        matchedOrders: fills.length,
        collateral,
        shares,
        averagePrice: shares ? collateral / shares : null,
        examples: fills.sort((a, b) => b.block - a.block).slice(0, 3),
      };
    }),
  };
}
