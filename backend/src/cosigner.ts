// The co-signer: build the register instruction and partial-sign it as the
// registrar. SOL mints use the burner as payer. Stock mints use the buyer as
// payer and keep the stock in that wallet until mint. We add only the registrar
// signature and return the rest for the client to complete.

import { BN } from "@coral-xyz/anchor";
import { PACKET_DATA_SIZE, PublicKey, Transaction, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { config } from "./config.ts";
import { withConnection } from "./rpcpool.ts";
import { buildRegisterItemIx, buildRegisterSingleIx, preparePaymentAccounts, program, sigBytes } from "./program.ts";
import { createPaymentAccount, isSol } from "./currencies.ts";
import { buildStockSwap, StockSwapError, stockPaymentTerms } from "./stock-swap.ts";
import { assetUri } from "./metadata.ts";
import type { CollectionRow, ItemRow, ReservationRow } from "./db.ts";

export type CoSigned = {
  transaction: string;
  lastValidBlockHeight: number;
  payWithSol?: {
    currencyMint: string;
    stockDueUnits: string;
    shortfallUnits: string;
    inputLimitLamports: string;
    feeLamports: number;
    routerProgram: string;
    poolAddresses: string[];
    intermediateUnits?: string;
  };
};

async function finish(ix: TransactionInstruction, feePayer: PublicKey, prepare: TransactionInstruction[] = []): Promise<CoSigned> {
  const { blockhash, lastValidBlockHeight } = await withConnection((c) => c.getLatestBlockhash("confirmed"));
  const tx = new Transaction().add(...prepare, ix);
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  tx.partialSign(config.registrar);
  return {
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    lastValidBlockHeight,
  };
}

export async function coSignRegisterItem(c: CollectionRow, item: ItemRow, r: ReservationRow, inscriptionSig: string, metaSig: string, asset: string, payWithSol = false): Promise<CoSigned> {
  const burner = new PublicKey(r.burner), buyer = new PublicKey(r.wallet), treasury = new PublicKey(c.treasury);
  const currency = isSol(c.currency_mint) ? null : new PublicKey(c.currency_mint!);
  const nftAsset = new PublicKey(asset);
  const ix = await buildRegisterItemIx(
    { collection: new PublicKey(c.core_collection), treasury, currencyMint: c.currency_mint },
    {
      index: item.item_index,
      contentHash: Buffer.from(item.image_sha256, "hex"),
      inscriptionSig: sigBytes(inscriptionSig),
      metaSig: sigBytes(metaSig),
      name: item.name,
      uri: assetUri(metaSig),
      // A stock buyer signs the register transaction directly. Stock never
      // moves into the inscription burner or leaves the buyer on failure.
      minter: currency ? buyer : burner,
      owner: buyer,
      asset: nftAsset,
    }
  );
  if (!currency) return finish(ix, burner);
  const setup = preparePaymentAccounts(buyer, treasury, currency);
  const accounts = await withConnection((c) => c.getMultipleAccountsInfo(setup.map(ix => ix.keys[1].pubkey), "confirmed"));
  const recipients = setup.filter((_, i) => !accounts[i]);
  if (!payWithSol) return finish(ix, buyer, recipients);
  if (nftAsset.equals(config.registrar.publicKey) || nftAsset.equals(buyer))
    throw new StockSwapError("Pay with SOL is unavailable for these accounts.");
  const { price, due, shortfall, hasBuyerAccount } = await stockPaymentTerms(buyer, currency, c.price_lamports);
  if (!shortfall) return finish(ix, buyer, recipients);

  const swap = await buildStockSwap(buyer, currency, nftAsset, shortfall);
  const guard = await program.methods.assertMintPrice(currency, new BN(price.toString()))
    .accountsStrict({ registry: new PublicKey(c.registry) }).instruction();
  const swapSetup = hasBuyerAccount ? [] : [createPaymentAccount(buyer, buyer, currency)];
  const [compute, ...route] = swap.instructions;
  const { blockhash, lastValidBlockHeight } = await withConnection(rpc => rpc.getLatestBlockhash("confirmed"));
  const message = new TransactionMessage({
    payerKey: buyer, recentBlockhash: blockhash,
    instructions: [compute, ...swapSetup, ...route, ...recipients, guard, ix],
  }).compileToV0Message(swap.lookupTables);
  const signers = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures);
  if (signers.length !== 3 || !signers[0].equals(buyer) ||
      !signers.some(key => key.equals(nftAsset)) || !signers.some(key => key.equals(config.registrar.publicKey))) {
    throw new StockSwapError("The swap introduced an unexpected signer.");
  }
  const tx = new VersionedTransaction(message);
  let serialized: Uint8Array;
  try {
    tx.sign([config.registrar]);
    serialized = tx.serialize();
    if (serialized.length > PACKET_DATA_SIZE) throw new Error("oversized packet");
  } catch {
    throw new StockSwapError("The swap and mint do not fit in one transaction.");
  }
  const fee = await withConnection(rpc => rpc.getFeeForMessage(message, "confirmed"));
  if (!Number.isSafeInteger(fee.value) || fee.value! < 0)
    throw new StockSwapError("The combined transaction fee could not be quoted.", 503);
  return {
    transaction: Buffer.from(serialized).toString("base64"),
    lastValidBlockHeight,
    payWithSol: {
      currencyMint: currency.toBase58(), stockDueUnits: due.toString(), shortfallUnits: shortfall.toString(),
      inputLimitLamports: swap.inputLimitLamports, feeLamports: fee.value!, routerProgram: swap.routerProgram, poolAddresses: swap.poolAddresses,
      ...(swap.intermediateUnits === undefined ? {} : { intermediateUnits: swap.intermediateUnits }),
    },
  };
}

export async function coSignRegisterSingle(c: CollectionRow, a: { wallet: string; burner: string; inscriptionSig: string; metaSig: string; name: string; asset: string }): Promise<CoSigned> {
  const ix = await buildRegisterSingleIx(
    { collection: new PublicKey(c.core_collection), treasury: new PublicKey(c.treasury), currencyMint: c.currency_mint },
    {
      inscriptionSig: sigBytes(a.inscriptionSig),
      metaSig: sigBytes(a.metaSig),
      name: a.name,
      uri: assetUri(a.metaSig),
      minter: new PublicKey(a.burner),
      owner: new PublicKey(a.wallet),
      asset: new PublicKey(a.asset),
    }
  );
  return finish(ix, new PublicKey(a.burner));
}
