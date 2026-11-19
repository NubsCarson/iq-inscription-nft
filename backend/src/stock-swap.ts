// The local provider implements Jupiter's ExactOut response shape. The server
// verifies the collection terms, then derives the quote from the on-chain balance.
import {
  AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram,
  PublicKey, TransactionInstruction,
} from "@solana/web3.js";
import { HTTPException } from "hono/http-exception";
import { config } from "./config.ts";
import { ataFor, STOCK_CURRENCIES, TOKEN_2022_PROGRAM } from "./currencies.ts";
import { withConnection } from "./rpcpool.ts";
import { ORCA_ROUTER, validateOrcaRoute } from "./orca-stock-swap.ts";
import { RAYDIUM_CLMM, validateRaydiumRoute } from "./raydium-stock-swap.ts";
import { classicAta, WRAPPED_SOL } from "./stock-swap-accounts.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_U64 = 2n ** 64n - 1n;

export class StockSwapError extends HTTPException {
  constructor(message: string, status: 422 | 503 = 422) {
    super(status, { message, res: Response.json({ error: message }, { status }) });
  }
}

const providerOrigin = (() => {
  if (!config.stockEnabled || process.env.STOCK_SOL_CHECKOUT_ENABLED !== "true") return null;
  const origin = process.env.STOCK_SOL_LOCAL_SWAP_ORIGIN;
  if (!origin) return null;
  const url = new URL(origin);
  if (config.cluster !== "devnet" || !config.rpcUrls.every(rpc => LOOPBACK.has(new URL(rpc).hostname)) ||
      url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.origin !== origin) {
    throw new Error("The stock swap fixture requires loopback RPC and quotes");
  }
  return url.origin;
})();

// One vetted route per approved stock. Config order is SOL to stock. Reject
// ambiguous routing rather than silently switching venues or pool paths.
const approvedRoutes = (() => {
  const routes = new Map<string, { router: PublicKey; pools: PublicKey[] }>();
  if (!providerOrigin) return routes;
  const approvedMints = new Set(STOCK_CURRENCIES.map(currency => currency.mint));
  for (const [router, settings] of [
    [ORCA_ROUTER, process.env.STOCK_SOL_ORCA_ROUTES],
    [RAYDIUM_CLMM, process.env.STOCK_SOL_RAYDIUM_ROUTES],
  ] as const) {
    const raw: unknown = JSON.parse(settings ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid stock route configuration");
    for (const [mint, pools] of Object.entries(raw)) {
      if (!approvedMints.has(mint) || routes.has(mint) || !Array.isArray(pools) ||
          (pools.length !== 1 && pools.length !== 2) ||
          pools.some(pool => typeof pool !== "string") || new Set(pools).size !== pools.length) {
        throw new Error("Invalid or ambiguous route for an approved stock mint");
      }
      routes.set(mint, { router, pools: pools.map(pool => new PublicKey(pool)) });
    }
  }
  return routes;
})();

export const stockSolMints: readonly string[] = Object.freeze([...approvedRoutes.keys()]);
export const stockSolEnabled = stockSolMints.length > 0;
export const supportsStockSol = (mint: string | null | undefined) => Boolean(mint && approvedRoutes.has(mint));

function uint(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw new StockSwapError("Invalid swap amount.");
  const n = BigInt(value);
  if (n > MAX_U64) throw new StockSwapError("Invalid swap amount.");
  return n;
}

async function routeJson(path: string, body?: unknown) {
  if (!providerOrigin) throw new StockSwapError("Pay with SOL is unavailable.", 503);
  let response: Response;
  try {
    response = await fetch(providerOrigin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(7_500),
    });
  } catch {
    throw new StockSwapError("The stock swap quote service is unavailable.", 503);
  }
  if (!response.ok) throw new StockSwapError("No usable exact-output swap is available for this mint.");
  try { return await response.json(); }
  catch { throw new StockSwapError("The stock swap quote service returned an invalid response.", 503); }
}

function parseIx(raw: any, buyer: PublicKey, asset: PublicKey): TransactionInstruction {
  if (!raw || typeof raw.programId !== "string" || !Array.isArray(raw.accounts) || raw.accounts.length > 64 ||
      typeof raw.data !== "string" || raw.data.length > 1_640 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data)) {
    throw new StockSwapError("Invalid swap instructions.");
  }
  const programId = new PublicKey(raw.programId);
  const keys = raw.accounts.map((entry: any) => {
    if (typeof entry?.pubkey !== "string" || typeof entry.isSigner !== "boolean" || typeof entry.isWritable !== "boolean")
      throw new StockSwapError("Invalid swap instruction account.");
    const pubkey = new PublicKey(entry.pubkey);
    // Compiled instruction privileges are merged across the transaction. The
    // router must never receive a registrar or NFT asset account, even read-only.
    if (pubkey.equals(config.registrar.publicKey) || pubkey.equals(asset) ||
        (entry.isSigner && !pubkey.equals(buyer))) {
      throw new StockSwapError("Unexpected signer or account in the swap route.");
    }
    return { pubkey, isSigner: entry.isSigner, isWritable: entry.isWritable };
  });
  return new TransactionInstruction({ programId, keys, data: Buffer.from(raw.data, "base64") });
}

async function exactOutputQuote(mint: PublicKey, shortfall: bigint) {
  if (shortfall <= 0n || shortfall > MAX_U64) throw new StockSwapError("Invalid stock shortfall.");
  const route = approvedRoutes.get(mint.toBase58());
  if (!route) throw new StockSwapError("Pay with SOL is unavailable for this mint.");
  const { router, pools } = route;
  const params = new URLSearchParams({
    inputMint: WRAPPED_SOL.toBase58(), outputMint: mint.toBase58(), amount: String(shortfall),
    swapMode: "ExactOut", slippageBps: "50", instructionVersion: "V2",
  });
  const quote = await routeJson("/swap/v1/quote?" + params);
  const input = uint(quote?.inAmount), limit = uint(quote?.otherAmountThreshold);
  if (quote?.swapMode !== "ExactOut" || quote.inputMint !== WRAPPED_SOL.toBase58() ||
      quote.outputMint !== mint.toBase58() || uint(quote.outAmount) !== shortfall ||
      input <= 0n || limit < input || limit > BigInt(Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(quote.routePlan) || quote.routePlan.length !== pools.length ||
      pools.some((pool, index) => quote.routePlan[index]?.swapInfo?.ammKey !== pool.toBase58())) {
    throw new StockSwapError("No exact-output quote matches the missing stock amount.");
  }
  const intermediate = router.equals(RAYDIUM_CLMM) && pools.length === 2 ? uint(quote.intermediateUnits) : undefined;
  if ((intermediate !== undefined && intermediate <= 0n) ||
      (intermediate === undefined && quote.intermediateUnits !== undefined)) {
    throw new StockSwapError("Invalid intermediate amount in the exact-output quote.");
  }
  return { quote, limit, router, pools, intermediate };
}

export async function stockPaymentTerms(buyer: PublicKey, currency: PublicKey, priceLamports: number) {
  if (!supportsStockSol(currency.toBase58()) || buyer.equals(config.registrar.publicKey))
    throw new StockSwapError("Pay with SOL is unavailable for this wallet.");
  const mint = STOCK_CURRENCIES.find(item => item.mint === currency.toBase58());
  if (!mint || !Number.isSafeInteger(priceLamports) || priceLamports <= 0)
    throw new StockSwapError("Pay with SOL is available only for approved positive-price stock mints.");

  const buyerToken = ataFor(buyer, currency);
  const [mintAccount, stock] = await withConnection(rpc => rpc.getMultipleAccountsInfo([currency, buyerToken], "confirmed"))
    .catch(() => { throw new StockSwapError("The stock payment accounts are unavailable. Try again.", 503); });
  if (!mintAccount?.owner.equals(TOKEN_2022_PROGRAM) || mintAccount.data.length < 82 ||
      mintAccount.data[44] !== mint.decimals || mintAccount.data[45] !== 1 ||
      (stock && (!stock.owner.equals(TOKEN_2022_PROGRAM) || stock.data.length < 165 ||
        !stock.data.subarray(0, 32).equals(currency.toBuffer()) ||
        !stock.data.subarray(32, 64).equals(buyer.toBuffer()) || stock.data[108] !== 1))) {
    throw new StockSwapError("The stock mint or buyer token account cannot settle this checkout.");
  }
  const price = BigInt(priceLamports);
  const due = price + (price * 500n) / 10_000n;
  const balance = stock?.data.readBigUInt64LE(64) ?? 0n;
  const shortfall = balance < due ? due - balance : 0n;
  return { price, due, shortfall, hasBuyerAccount: stock !== null };
}

export async function quoteStockPayment(buyer: PublicKey, currency: PublicKey, priceLamports: number) {
  const { due, shortfall } = await stockPaymentTerms(buyer, currency, priceLamports);
  if (!shortfall) return null;
  const wrapped = await withConnection(rpc => rpc.getAccountInfo(classicAta(buyer, WRAPPED_SOL), "confirmed"))
    .catch(() => { throw new StockSwapError("The wrapped SOL account check is temporarily unavailable.", 503); });
  if (wrapped) throw new StockSwapError("The rehearsal requires a fresh wrapped SOL account.");
  const { limit, router, pools, intermediate } = await exactOutputQuote(currency, shortfall);
  return {
    currencyMint: currency.toBase58(), stockDueUnits: due.toString(),
    shortfallUnits: shortfall.toString(), inputLimitLamports: limit.toString(),
    routerProgram: router.toBase58(), poolAddresses: pools.map(pool => pool.toBase58()),
    ...(intermediate === undefined ? {} : { intermediateUnits: intermediate.toString() }),
  };
}

export async function buildStockSwap(buyer: PublicKey, mint: PublicKey, asset: PublicKey, shortfall: bigint) {
  const { quote, limit, router, pools, intermediate } = await exactOutputQuote(mint, shortfall);
  const raydium = router.equals(RAYDIUM_CLMM);
  const raw = await routeJson("/swap/v1/swap-instructions", {
    quoteResponse: quote, userPublicKey: buyer.toBase58(), wrapAndUnwrapSol: true,
  });
  if (raw?.tokenLedgerInstruction || raw?.otherInstructions?.length || raw?.computeBudgetInstructions?.length ||
      !Array.isArray(raw?.setupInstructions) || !Array.isArray(raw.addressLookupTableAddresses) ||
      raw.addressLookupTableAddresses.length > 6) {
    throw new StockSwapError("The swap needs unsupported setup instructions.");
  }
  const output = ataFor(buyer, mint);
  if (raydium ? raw.swapInstruction !== undefined || raw.cleanupInstruction !== undefined ||
      !Array.isArray(raw.swapInstructions) || raw.swapInstructions.length !== pools.length ||
      !Array.isArray(raw.cleanupInstructions) || raw.cleanupInstructions.length !== 1 ||
      raw.setupInstructions.length < 3 || raw.setupInstructions.length > (pools.length === 2 ? 4 : 3)
    : raw.swapInstructions !== undefined || raw.cleanupInstructions !== undefined ||
      raw.setupInstructions.length !== 3 || !raw.cleanupInstruction) {
    throw new StockSwapError("The swap needs unsupported instructions.");
  }
  const swaps: TransactionInstruction[] = (raydium ? raw.swapInstructions : [raw.swapInstruction])
    .map((ix: unknown) => parseIx(ix, buyer, asset));
  if (swaps.some(swap => !swap.programId.equals(router) ||
      !swap.keys.some(key => key.pubkey.equals(buyer) && key.isSigner)) ||
      !swaps.at(-1)?.keys.some(key => key.pubkey.equals(output) && key.isWritable)) {
    throw new StockSwapError("The swap uses an unexpected router or destination.");
  }

  const setup = raw.setupInstructions.map((ix: unknown) => parseIx(ix, buyer, asset));
  const cleanup = parseIx(raydium ? raw.cleanupInstructions[0] : raw.cleanupInstruction, buyer, asset);
  try {
    if (raydium) await validateRaydiumRoute(setup, swaps, cleanup, buyer, mint, pools, shortfall, limit, intermediate);
    else await validateOrcaRoute(setup, swaps[0], cleanup, buyer, mint, pools, shortfall, limit);
  } catch (error) {
    throw new StockSwapError(error instanceof Error ? error.message : "Could not validate the exact-output swap.");
  }
  const lookupKeys = raw.addressLookupTableAddresses.map((address: string) => new PublicKey(address));
  const lookupTables = lookupKeys.length ? await withConnection(async c => {
    const accounts = await c.getMultipleAccountsInfo(lookupKeys, "confirmed");
    return accounts.map((info, index) => {
      if (!info?.owner.equals(AddressLookupTableProgram.programId)) throw new StockSwapError("A swap lookup table is unavailable.");
      const table = new AddressLookupTableAccount({ key: lookupKeys[index], state: AddressLookupTableAccount.deserialize(info.data) });
      if (!table.isActive()) throw new StockSwapError("A swap lookup table is inactive.");
      return table;
    });
  }) : [];
  return {
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...setup, ...swaps, cleanup],
    lookupTables,
    inputLimitLamports: limit.toString(), routerProgram: router.toBase58(),
    poolAddresses: pools.map(pool => pool.toBase58()),
    ...(intermediate === undefined ? {} : { intermediateUnits: intermediate.toString() }),
  };
}
