import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM } from "./currencies.ts";

export const WRAPPED_SOL = new PublicKey("So11111111111111111111111111111111111111112");
export const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const discriminator = (name: string) => createHash("sha256").update(name).digest().subarray(0, 8);

export function classicAta(owner: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

export const matches = (ix: TransactionInstruction | undefined, program: PublicKey, accounts: (PublicKey | null)[]) =>
  ix?.programId.equals(program) && ix.keys.length === accounts.length &&
  accounts.every((key, i) => key === null || key.equals(ix.keys[i].pubkey));

// The three setup instructions can wrap only the reviewed SOL cap. A
// non-idempotent create prevents the route touching a pre-existing WSOL ATA,
// even if it appears between checking the account and executing the quote.
export function validateWrappedSolCap(
  setup: TransactionInstruction[],
  cleanup: TransactionInstruction,
  buyer: PublicKey,
  wrapped: PublicKey,
  limit: bigint,
) {
  const [create, fund, sync] = setup;
  if (setup.length !== 3 ||
      !matches(create, ASSOCIATED_TOKEN_PROGRAM, [buyer, wrapped, buyer, WRAPPED_SOL, SystemProgram.programId, TOKEN_PROGRAM]) ||
      create.data.length !== 0 || !create.keys[0].isSigner || !create.keys[1].isWritable ||
      !matches(fund, SystemProgram.programId, [buyer, wrapped]) || fund.data.length !== 12 ||
      fund.data.readUInt32LE(0) !== 2 || fund.data.readBigUInt64LE(4) !== limit || !fund.keys[0].isSigner ||
      !matches(sync, TOKEN_PROGRAM, [wrapped]) || sync.data.length !== 1 || sync.data[0] !== 17 ||
      !matches(cleanup, TOKEN_PROGRAM, [wrapped, buyer, buyer]) || cleanup.data.length !== 1 ||
      cleanup.data[0] !== 9 || !cleanup.keys[2].isSigner) {
    throw new Error("The swap did not bind the reviewed SOL cap and refund destination.");
  }
}
